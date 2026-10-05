/**
 * 纯文本三方合并：不依赖 git 与文件系统，只对三段文本做行级合并。
 *
 * 规则（与 ConflictContentSource 的约定一致，`null` 表示该侧不存在文件）：
 * - 双方一致 → clean；仅一方相对 base 改动 → clean 取该方；
 * - 双方都改动 → 基于 LCS 的行级合并，交叠区域输出标准冲突标记；
 * - 单侧删除 + 另一侧修改 → conflict；两侧都删除 → both-deleted；
 * - 任一侧含 NUL 字节 → binary；任一侧超过 MAX_MERGE_LINES 行 →
 *   放弃逐行合并，直接输出包裹整个文件的冲突标记，避免 O(n*m) 卡死。
 */

export interface MergeOutcome {
  status: 'clean' | 'conflict' | 'binary' | 'both-deleted'
  /** 合并后的文本；status 为 clean 且内容为 undefined 时表示解析结果是文件被删除。 */
  content?: string
  /** 冲突区块数量，仅在 status 为 conflict 时有意义。 */
  conflictCount?: number
}

/** 行数保险丝：超过该值的一侧不再做逐行 LCS 合并。 */
export const MAX_MERGE_LINES = 20_000

/** LCS 动态规划单元格上限，行数保险丝之外的第二道防卡死保护。 */
const MAX_LCS_CELLS = 4_000_000

const LOCAL_MARKER = '<<<<<<< LOCAL'
const SEP_MARKER = '======='
const UPSTREAM_MARKER = '>>>>>>> UPSTREAM'

interface Hunk {
  baseStart: number
  baseEnd: number
  lines: string[]
}

function toLines(content: string): string[] {
  return content === '' ? [] : content.split('\n')
}

function fromLines(lines: string[]): string {
  return lines.join('\n')
}

function isBinary(...contents: (string | null)[]): boolean {
  return contents.some(content => content !== null && content.includes('\u0000'))
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length)
    return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i])
      return false
  }
  return true
}

/** 放弃逐行合并时使用的整文件冲突标记。 */
function wholeFileConflict(local: string | null, upstream: string | null): MergeOutcome {
  const localLines = local === null ? [] : toLines(local)
  const upstreamLines = upstream === null ? [] : toLines(upstream)
  const lines = [LOCAL_MARKER, ...localLines, SEP_MARKER, ...upstreamLines, UPSTREAM_MARKER]
  return { status: 'conflict', content: fromLines(lines), conflictCount: 1 }
}

/** 返回 a、b 两组行中相等下标对（基于 LCS 动态规划），用于推导变更块。 */
function lcsPairs(a: string[], b: string[]): [number, number][] {
  const n = a.length
  const m = b.length
  const pairs: [number, number][] = []
  if (n === 0 || m === 0)
    return pairs

  const width = m + 1
  const dp = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }

  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i++
      j++
    }
    else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      i++
    }
    else {
      j++
    }
  }
  return pairs
}

/** 相对 base 的每一段连续改动折叠成一个替换块（base 区间 → 该侧新行）。 */
function diffHunks(base: string[], side: string[]): Hunk[] {
  const hunks: Hunk[] = []
  let i = 0
  let j = 0
  for (const [pi, pj] of lcsPairs(base, side)) {
    if (pi > i || pj > j)
      hunks.push({ baseStart: i, baseEnd: pi, lines: side.slice(j, pj) })
    i = pi + 1
    j = pj + 1
  }
  if (i < base.length || j < side.length)
    hunks.push({ baseStart: i, baseEnd: base.length, lines: side.slice(j) })
  return hunks
}

/** 把某侧在区间 [start, end) 内的最终文本还原出来（未覆盖的 base 行原样保留）。 */
function sideRegionLines(
  base: string[],
  hunks: Hunk[],
  from: number,
  to: number,
  start: number,
  end: number,
): string[] {
  const out: string[] = []
  let pos = start
  for (let k = from; k < to; k++) {
    const hunk = hunks[k]
    out.push(...base.slice(pos, hunk.baseStart))
    out.push(...hunk.lines)
    pos = Math.max(pos, hunk.baseEnd)
  }
  out.push(...base.slice(pos, end))
  return out
}

interface RegionMerge {
  lines: string[]
  conflicts: number
}

/** diff3 风格合并：把双方相交/相邻的变更块归入同一区域，区域内容不一致才打标记。 */
function mergeSideHunks(base: string[], localHunks: Hunk[], upstreamHunks: Hunk[]): RegionMerge {
  const lines: string[] = []
  let conflicts = 0
  let i = 0
  let li = 0
  let ui = 0

  while (i <= base.length) {
    const lStart = li < localHunks.length ? localHunks[li].baseStart : Number.POSITIVE_INFINITY
    const uStart = ui < upstreamHunks.length ? upstreamHunks[ui].baseStart : Number.POSITIVE_INFINITY
    const next = Math.min(lStart, uStart)
    if (!Number.isFinite(next))
      break

    if (next > i) {
      lines.push(...base.slice(i, next))
      i = next
    }

    let lEnd = li
    let uEnd = ui
    let end = i
    let grew = true
    while (grew) {
      grew = false
      if (lEnd < localHunks.length && localHunks[lEnd].baseStart <= end) {
        end = Math.max(end, localHunks[lEnd].baseEnd)
        lEnd++
        grew = true
      }
      if (uEnd < upstreamHunks.length && upstreamHunks[uEnd].baseStart <= end) {
        end = Math.max(end, upstreamHunks[uEnd].baseEnd)
        uEnd++
        grew = true
      }
    }

    const baseRegion = base.slice(i, end)
    const localRegion = sideRegionLines(base, localHunks, li, lEnd, i, end)
    const upstreamRegion = sideRegionLines(base, upstreamHunks, ui, uEnd, i, end)

    if (arraysEqual(localRegion, upstreamRegion)) {
      lines.push(...localRegion)
    }
    else if (arraysEqual(localRegion, baseRegion)) {
      lines.push(...upstreamRegion)
    }
    else if (arraysEqual(upstreamRegion, baseRegion)) {
      lines.push(...localRegion)
    }
    else {
      lines.push(LOCAL_MARKER, ...localRegion, SEP_MARKER, ...upstreamRegion, UPSTREAM_MARKER)
      conflicts++
    }

    i = end
    li = lEnd
    ui = uEnd
  }

  return { lines, conflicts }
}

export function threeWayMerge(base: string | null, local: string | null, upstream: string | null): MergeOutcome {
  if (local === null && upstream === null)
    return { status: 'both-deleted' }
  if (isBinary(base, local, upstream))
    return { status: 'binary' }

  // 单侧删除：另一侧未改动则接受删除（clean，无内容），否则 delete+modify 冲突。
  if (local === null || upstream === null) {
    const surviving = (local ?? upstream) as string
    if (base === null)
      return { status: 'clean', content: surviving }
    if (surviving === base)
      return { status: 'clean' }
    return wholeFileConflict(local, upstream)
  }

  if (local === upstream)
    return { status: 'clean', content: local }
  if (base !== null && base === local)
    return { status: 'clean', content: upstream }
  if (base !== null && base === upstream)
    return { status: 'clean', content: local }

  const baseLines = toLines(base ?? '')
  const localLines = toLines(local)
  const upstreamLines = toLines(upstream)

  if (baseLines.length > MAX_MERGE_LINES || localLines.length > MAX_MERGE_LINES || upstreamLines.length > MAX_MERGE_LINES) {
    return wholeFileConflict(local, upstream)
  }

  // 三方公共前缀/后缀先行裁掉，既提速又把 LCS 动态规划压进中段。
  let prefix = 0
  while (
    prefix < baseLines.length
    && prefix < localLines.length
    && prefix < upstreamLines.length
    && baseLines[prefix] === localLines[prefix]
    && baseLines[prefix] === upstreamLines[prefix]
  ) {
    prefix++
  }
  let suffix = 0
  while (
    suffix < baseLines.length - prefix
    && suffix < localLines.length - prefix
    && suffix < upstreamLines.length - prefix
    && baseLines[baseLines.length - 1 - suffix] === localLines[localLines.length - 1 - suffix]
    && baseLines[baseLines.length - 1 - suffix] === upstreamLines[upstreamLines.length - 1 - suffix]
  ) {
    suffix++
  }

  const baseMid = baseLines.slice(prefix, baseLines.length - suffix)
  const localMid = localLines.slice(prefix, localLines.length - suffix)
  const upstreamMid = upstreamLines.slice(prefix, upstreamLines.length - suffix)

  if (baseMid.length * localMid.length > MAX_LCS_CELLS || baseMid.length * upstreamMid.length > MAX_LCS_CELLS) {
    return wholeFileConflict(local, upstream)
  }

  const merged = mergeSideHunks(baseMid, diffHunks(baseMid, localMid), diffHunks(baseMid, upstreamMid))
  const resultLines = [
    ...baseLines.slice(0, prefix),
    ...merged.lines,
    ...baseLines.slice(baseLines.length - suffix),
  ]

  return merged.conflicts > 0
    ? { status: 'conflict', content: fromLines(resultLines), conflictCount: merged.conflicts }
    : { status: 'clean', content: fromLines(resultLines) }
}
