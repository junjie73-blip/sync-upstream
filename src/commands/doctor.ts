import type { SyncConfig } from '../domain'
import type { GitRepository } from '../git/repository'
import type { Facts } from './facts'
import type { CheckLevel, CommandContext, CommandOutput, DoctorCheck, DoctorReport } from './types'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import fs from 'fs-extra'
import { bold, cyan, dim, gray, green, red, yellow } from 'picocolors'
import pkg from '../../package.json'
import { DEFAULT_LOG_CONFIG, filterArg, NotifyChannel } from '../domain'
import { toError } from '../errors'
import { joinRepoPath } from '../fsx/paths'
import { lfsAvailable } from '../git/lfs'
import { redacted, toClonableUrl } from '../git/url'
import { findPrTool, toolForRemote } from '../pipeline/pr-cli'
import { readDeliveryLog } from '../webhook/delivery-log'
import { collectFacts, openRepository } from './facts'
import { toReport } from './output'
import { shortHash } from './status'

/** `git commit --pathspec-from-file`, which keeps one run from sweeping up foreign files. */
const MIN_GIT = { major: 2, minor: 25 }

const MARK: Record<CheckLevel, (value: string) => string> = {
  pass: value => green(value),
  warn: value => yellow(value),
  fail: value => red(value),
  info: value => gray(value),
}

const SIGN: Record<CheckLevel, string> = { pass: '✓', warn: '!', fail: 'x', info: '-' }

/** Can git bind this port right now? A daemon that fails at 03:00 is worse than one that refuses to start. */
async function probePort(port: number, host: string): Promise<string | null> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message))
    server.once('listening', () => {
      server.close(() => resolve(null))
    })
    server.listen(port, host)
  })
}

/**
 * Can this path be appended to? Returns the reason it cannot, or `undefined` when it can.
 *
 * Checked rather than tried: doctor must not put a line into the operator's log file to find out
 * whether the log file works.
 */
function checkAppendable(file: string): string | undefined {
  try {
    const dir = path.dirname(file)
    fs.ensureDirSync(dir)
    fs.accessSync(dir, fs.constants.W_OK)
    if (fs.existsSync(file))
      fs.accessSync(file, fs.constants.W_OK)
    return undefined
  }
  catch (error) {
    return toError(error).message
  }
}

function parseVersion(value: string): { major: number, minor: number } | null {
  const match = /^(\d+)\.(\d+)/.exec(value)
  if (!match)
    return null
  return { major: Number(match[1]), minor: Number(match[2]) }
}

function isLoopback(host: string): boolean {
  // `0.0.0.0` binds every interface, which is the opposite of loopback-only.
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

interface AuthRow {
  level: CheckLevel
  message: string
  hint?: string
}

/** Validate the credential block without touching the network — nothing here proves access works. */
async function checkAuth(config: SyncConfig, cwd: string): Promise<AuthRow | null> {
  const auth = config.authConfig
  if (!auth)
    return null
  if (auth.type === 'pat' && !auth.token)
    return { level: 'fail', message: 'authConfig.type=pat 但没有 token', hint: '写在配置文件的 authConfig.token 里；--auth-token 只在临时验证时用，命令行参数同机的其他进程读得到' }
  if (auth.type === 'user_pass' && (!auth.username || !auth.password))
    return { level: 'fail', message: 'authConfig.type=user_pass 缺少 username/password' }
  if (auth.type === 'ssh' && auth.privateKeyPath && !(await fs.pathExists(path.resolve(cwd, auth.privateKeyPath))))
    return { level: 'fail', message: `SSH 私钥不存在: ${auth.privateKeyPath}`, hint: '路径按运行目录解析；带口令的私钥请先交给 ssh-agent' }
  return { level: 'pass', message: `认证方式 ${auth.type}` }
}

export async function doctorCommand(context: CommandContext): Promise<CommandOutput<DoctorReport>> {
  const { config, cwd } = context
  const checks: DoctorCheck[] = []
  const add = (id: string, level: CheckLevel, message: string, hint?: string): void => {
    checks.push({ id, level, message, ...(hint ? { hint } : {}) })
  }

  const nodeMajor = Number(process.versions.node.split('.')[0])
  const enginesNode = (pkg as unknown as { engines?: Record<string, string> }).engines?.node
  if (enginesNode) {
    const required = Number(/(\d+)/.exec(enginesNode)?.[1] ?? 0)
    add('node', nodeMajor >= required ? 'pass' : 'fail', `Node ${process.version}（要求 ${enginesNode}）`, nodeMajor >= required ? undefined : `切换到 Node ${required}+ 后重试`)
  }
  else {
    add('node', 'info', `Node ${process.version}`)
  }

  // A missing SSH key is an `auth` finding, not a broken repository: `sshCommand` refuses to
  // build the git environment, so the credential check has to run before the handle exists.
  const authRow = await checkAuth(config, cwd)
  let git: GitRepository | null = null
  try {
    git = openRepository(config, cwd)
  }
  catch (error) {
    add('git', 'fail', `无法初始化 git 句柄: ${toError(error).message}`, '先处理 auth 一项再重新运行')
  }

  const version = git ? await git.version().catch(() => '') : ''
  const parsed = parseVersion(version)
  if (git) {
    if (!parsed)
      add('git', 'fail', '无法读取 git 版本', '确认已安装 git 并在 PATH 中')
    else if (parsed.major < MIN_GIT.major || (parsed.major === MIN_GIT.major && parsed.minor < MIN_GIT.minor))
      add('git', 'fail', `git ${version} 过旧`, `需要 ${MIN_GIT.major}.${MIN_GIT.minor} 以上（提交范围依赖 --pathspec-from-file）`)
    else
      add('git', 'pass', `git ${version}`)
  }

  const hasUpstream = Boolean(config.upstreamRepo) || (config.upstreams ?? []).filter(Boolean).length > 0
  if (context.configProblems && context.configProblems.length > 0) {
    // Doctor is allowed to run on a configuration a sync would refuse; when it does, that is the
    // headline finding, not a footnote — `跑一次 sync 会直接失败` is what the user needs to know.
    add('config', 'fail', `配置尚不可用：${context.configProblems.join('；')}`, '运行 sync-upstream init 补齐，或用 -r / -d 临时指定')
  }
  else {
    add('config', hasUpstream ? 'pass' : 'warn', `配置文件：${context.configSource ?? '（未找到，使用默认值 + 命令行）'}`, context.configSource ? undefined : '运行 sync-upstream -g 生成一份')
  }
  if (authRow)
    add('auth', authRow.level, authRow.message, authRow.hint)

  let facts: Facts | null = null
  if (git) {
    try {
      facts = await collectFacts(config, cwd)
    }
    catch (error) {
      add('worktree', 'fail', `当前目录不是可用的 Git 工作区: ${(error as Error).message}`, '在目标仓库目录内运行，或用 -C 指定配置')
    }
  }

  if (facts && git) {
    const { repo, lock } = facts
    const fanIn = facts.sources.length > 1
    let symlinkWarned = false
    add('worktree', 'pass', `${repo.root} · 当前分支 ${repo.currentBranch} · HEAD ${shortHash(repo.head)}`)
    if (await git.branchExists(config.companyBranch))
      add('target-branch', 'pass', `目标分支 ${config.companyBranch} 已存在`)
    else if (await git.refExists(`refs/remotes/origin/${config.companyBranch}`))
      add('target-branch', 'pass', `目标分支 ${config.companyBranch} 只在 origin 存在，运行时会自动检出跟踪分支`)
    else
      add('target-branch', 'fail', `目标分支 ${config.companyBranch} 本地和 origin 都没有`, `先 git branch ${config.companyBranch} origin/${config.companyBranch}`)

    if (fanIn)
      add('upstreams', 'info', `${facts.sources.length} 个上游 fan-in：${facts.sources.map(item => item.source.label).join('、')}`, '灰度发布与 --rollback 暂不支持多上游；目录重叠时后一个上游覆盖前一个')

    if (lock.held)
      add('repo-lock', lock.holder?.stale ? 'warn' : 'fail', `仓库锁被占用：pid ${lock.holder?.pid} · ${lock.holder?.label} · ${lock.holder?.createdAt}`, lock.holder?.stale ? `持有者已退出，下次获取会自动接管（或手动删除 ${lock.file}）` : `等待其结束，或配置 lockWaitMs / --lock-wait`)
    else
      add('repo-lock', 'pass', '仓库锁空闲')

    for (const item of facts.sources) {
      const source = item.source
      const suffix = fanIn ? `（${source.label}）` : ''

      for (const dir of source.dirs) {
        const onDisk = await fs.pathExists(joinRepoPath(repo.root, dir))
        const ref = item.upstreamRef ?? (await git.branchExists(config.companyBranch) ? config.companyBranch : null)
        const objects = ref ? (await git.listTree(ref, [dir])).size : 0
        if (objects === 0 && !onDisk)
          add('sync-dir', 'warn', `同步目录 ${dir}${suffix} 在工作区和 Git 里都不存在`, '检查拼写；同步目录是仓库根目录下的相对路径')
        else if (objects === 0)
          add('sync-dir', 'warn', `同步目录 ${dir}${suffix} 在 ${ref ?? '可比对的分支'} 上没有文件`, '上游该目录为空时同步不会产生任何变更')
        else
          add('sync-dir', 'pass', `${dir}${suffix} · ${objects} 个对象`)

        const absolute = dir.startsWith('/') || /^[a-z]:[\\/]/i.test(dir)
        if (absolute)
          add('sync-dir', 'fail', `同步目录 ${dir}${suffix} 是绝对路径`, '只接受仓库根目录下的相对路径')
      }

      const state = item.state
      if (!state.exists)
        add('state-file', 'info', `${source.stateFile}${suffix} 尚未生成`, '首次同步后出现，用于增量跳过')
      else if (!state.readable)
        add('state-file', 'fail', `${source.stateFile}${suffix} 无法解析: ${state.error}`, '确认没有正在运行的同步后可删除该文件重建')
      else if (!state.identityMatches)
        add('state-file', 'warn', `${source.stateFile}${suffix} 属于 ${state.identity.upstreamBranch || '?'} → ${state.identity.companyBranch || '?'}`, '换上游仓库或目标分支后增量状态会被丢弃，本次将全量比对')
      else
        add('state-file', 'pass', `${state.entries} 条记录${suffix} · 历史 ${state.history} 次 · 最近 ${state.lastSyncedAt ?? '未知'}`)

      if (state.exists && !(await git.isIgnoredByGit(source.stateFile)))
        add('state-ignore', 'warn', `${source.stateFile}${suffix} 未被 .gitignore 忽略`, '每次同步后它会出现在未跟踪列表；建议加入 .gitignore（该文件属于本地状态）')

      // Incomplete credentials make `toClonableUrl` throw — and reporting them is the `auth`
      // check's job below, so the health check must not crash on the way there.
      const remoteUrl = await git.remoteUrl(source.remote)
      let expected: string | undefined
      try {
        expected = toClonableUrl(source.repo, config.authConfig)
      }
      catch {
        expected = undefined
      }
      if (!remoteUrl)
        add('remote', 'info', `远程 ${source.remote}${suffix} 尚未配置`, '首次运行会自动添加，不影响本次诊断')
      else if (expected && remoteUrl !== expected)
        add('remote', 'warn', `远程 ${source.remote}${suffix} 指向 ${remoteUrl}`, '运行时会被改写为配置里的 upstreamRepo')
      else
        add('remote', 'pass', `${source.remote}${suffix} → ${remoteUrl}`)

      if (item.upstreamRef)
        add('upstream-snapshot', 'pass', `${item.upstreamRef}${suffix} @ ${shortHash(item.upstreamRevision)}${item.lastFetchAt ? ` · 抓取于 ${item.lastFetchAt}` : ''}`)
      else
        add('upstream-snapshot', 'info', `本地没有上游快照${suffix}`, '运行 sync-upstream status --fetch 或 sync-upstream -P')

      const plan = item.plan
      if (plan) {
        const links = plan.skipped.filter(entry => entry.reason === 'symlink-unsupported')
        const submodules = plan.skipped.filter(entry => entry.reason === 'submodule')
        if (links.length > 0) {
          symlinkWarned = true
          add('symlinks', 'warn', `${links.length} 个符号链接未写入${suffix}（core.symlinks=false）`, 'Windows 需开启开发者模式，或 git config core.symlinks true 后重新检出')
        }
        if (submodules.length > 0)
          add('submodules', 'warn', `${submodules.length} 个 gitlink 无法按文件同步${suffix}`, '在目标仓库手动 git submodule add/update')
      }

      const attributes = item.upstreamRef
        ? await git.readBlobText(item.upstreamRef, '.gitattributes').catch(() => '')
        : ''
      if (/filter\s*=\s*lfs/.test(attributes))
        add('lfs', 'warn', `上游 .gitattributes 声明了 Git LFS${suffix}`, '同步的是 LFS 指针文本；目标仓库需要 git lfs pull 才能取回真实二进制')
    }

    if (!symlinkWarned)
      add('symlinks', (await git.supportsSymlinks()) ? 'pass' : 'info', process.platform === 'win32' ? 'core.symlinks=false（Windows 默认）' : '符号链接可正常写入')

    const scopeDirs = [...new Set(facts.sources.flatMap(item => item.source.dirs))]
    const [modified, untracked, staged] = await Promise.all([
      git.locallyModifiedPaths(scopeDirs),
      git.untrackedPaths(scopeDirs),
      git.stagedPaths(),
    ])
    if (modified.length > 0)
      add('working-tree', 'warn', `同步目录内 ${modified.length} 个文件已被本地修改`, '这些路径会与上游改动构成冲突，先提交或还原更干净')
    if (untracked.length > 0)
      add('working-tree', 'warn', `同步目录内 ${untracked.length} 个未跟踪文件`, '若与上游新增同名，会触发 untracked-overwrite 冲突')
    if (modified.length === 0 && untracked.length === 0)
      add('working-tree', 'pass', '同步目录内工作区干净')
    if (staged.length > 0)
      add('index', 'warn', `暂存区已有 ${staged.length} 个文件`, '提交范围会被限制在本次同步的路径，避免误提交他人暂存的内容')

    if (process.platform === 'win32' && (await git.configValue('core.filemode')) !== 'true')
      add('filemode', 'info', 'core.filemode=false（Windows 常见）', '权限位变化只靠索引记录，本工具已避免用 --only 提交把它们丢掉')
  }

  const webhook = config.webhookConfig
  if (webhook?.enable) {
    const host = webhook.host ?? '127.0.0.1'
    const taken = await probePort(webhook.port, host)
    if (taken === null)
      add('webhook-port', 'pass', `${host}:${webhook.port}${webhook.path} 可监听`)
    else
      add('webhook-port', 'fail', `${host}:${webhook.port} 无法监听（${taken}）`, '换个端口，或先停掉占用进程')
    if (webhook.secret.length < 16)
      add('webhook-secret', 'warn', `webhookConfig.secret 只有 ${webhook.secret.length} 个字符`, '建议使用 32 位以上随机串')
    if (!isLoopback(host) && !webhook.tlsCert)
      add('webhook-tls', 'warn', `监听 ${host} 但没有配置 tlsCert/tlsKey`, '公网明文端口任何人都能投递；请放在反代后面或启用 TLS')
    if (!isLoopback(host) && (webhook.securityConfig?.ipWhitelist?.length ?? 0) === 0)
      add('webhook-allowlist', 'warn', '对外监听却没有 ipWhitelist', '签名之外再加一层来源限制')
    for (const [key, value] of [['tlsCert', webhook.tlsCert], ['tlsKey', webhook.tlsKey]] as const) {
      if (value && !(await fs.pathExists(path.resolve(cwd, value))))
        add('webhook-tls', 'fail', `webhookConfig.${key} 指向的文件不存在: ${value}`)
    }
    if (webhook.trustProxy)
      add('webhook-proxy', 'info', 'trustProxy=true：x-forwarded-for 参与白名单与限流判断', '只有确实位于可信反代之后才应开启')
  }

  const notify = config.notifyConfig
  if (notify?.enable) {
    if (nodeMajor < 18)
      add('notify', 'fail', `Node ${nodeMajor} 没有内置 fetch，通知发不出去`, '切换到 Node 18 以上')
    const urls: Partial<Record<NotifyChannel, string | undefined>> = {
      [NotifyChannel.HTTP]: notify.url,
      [NotifyChannel.SLACK]: notify.slackUrl,
      [NotifyChannel.DINGTALK]: notify.dingtalkUrl,
      [NotifyChannel.WECOM]: notify.wecomUrl,
    }
    const urlKeys: Partial<Record<NotifyChannel, string>> = {
      [NotifyChannel.HTTP]: 'notifyConfig.url',
      [NotifyChannel.SLACK]: 'notifyConfig.slackUrl',
      [NotifyChannel.DINGTALK]: 'notifyConfig.dingtalkUrl',
      [NotifyChannel.WECOM]: 'notifyConfig.wecomUrl',
    }
    if (notify.channels.length === 0)
      add('notify', 'fail', '启用了通知但没有渠道', 'notifyConfig.channels 取 stdout|http|slack|dingtalk|wecom')
    for (const channel of notify.channels) {
      if (channel === NotifyChannel.STDOUT) {
        add('notify', 'pass', 'stdout 渠道写入日志，无需配置')
        continue
      }
      const url = urls[channel]
      if (!url)
        add('notify', 'fail', `${channel} 渠道没有地址`, `填 ${urlKeys[channel] ?? 'notifyConfig.url'}`)
      else if (!/^https?:\/\//i.test(url))
        add('notify', 'fail', `${channel} 的地址不是 http(s): ${redacted(url)}`, '聊天机器人的 webhook 一律是 HTTPS')
      else
        add('notify', 'pass', `${channel} → ${redacted(url)}`)
      if (channel === NotifyChannel.DINGTALK && !notify.dingtalkSecret)
        add('notify', 'warn', '钉钉渠道没有 dingtalkSecret', '机器人开启“加签”时会拒收，errcode 310000')
    }
    if (notify.events.includes('noop') && notify.channels.some(channel => channel !== NotifyChannel.STDOUT))
      add('notify', 'info', 'noop 也会通知', '上游有新提交但同步目录没变化时同样会播报，通常不是团队想要的')
  }

  if (config.grayReleaseConfig?.enable)
    add('gray-release', 'info', `灰度策略 ${config.grayReleaseConfig.strategy}，校验命令 ${config.grayReleaseConfig.validationScript ?? '(未配置)'}`, config.grayReleaseConfig.validationScript ? undefined : '没有校验命令时灰度只按文件选择，不会自动判定成败')

  // Deletions and renames are the two policy switches that change what lands on the branch, so
  // `doctor` states them the way it states the gray strategy: with what they would do today.
  const protectedDeletes = (facts?.sources ?? []).flatMap(item => item.plan?.skipped.filter(entry => entry.reason === 'delete-protected') ?? [])
  if (config.deletePolicy !== 'mirror') {
    add(
      'delete-policy',
      protectedDeletes.length > 0 ? 'warn' : 'info',
      `deletePolicy=${config.deletePolicy}${protectedDeletes.length > 0 ? `：当前有 ${protectedDeletes.length} 个上游已删除的文件被保留` : '：目前没有待保留的删除'}`,
      config.deletePolicy === 'ask'
        ? '非交互式运行（-y / --json）时按保留处理；要跟随删除请用 mirror 或 --delete'
        : '这些文件在上游已经不存在，会一直留在目标分支；确认后用 --delete 或 deletePolicy: mirror',
    )
  }
  else if (protectedDeletes.length > 0) {
    add('delete-policy', 'warn', `${protectedDeletes.length} 个删除被跳过，但 deletePolicy 是 mirror`, '多半是灰度发布限制了范围，或本次为询问模式选择了保留')
  }
  if (config.renameDetection)
    add('renames', 'info', `改名识别开启（阈值 ${config.renameThreshold}%）`, '上游改名的文件会以 git mv 落到新路径，本地未提交改动一并带过去；关闭用 --no-renames')
  else
    add('renames', 'info', '改名识别关闭：上游改名会按“删除 + 新增”处理', '本地在该路径上的未提交改动会被删除；需要保留改名请开启 renameDetection')

  // Large-repository options change what a fetch transfers and what the local history looks like,
  // which is exactly the kind of thing `doctor` exists to make visible before a run is blamed on
  // the tool for being slow or for "losing" commits.
  const fetch = config.fetchConfig
  if (fetch && (fetch.filter !== 'none' || fetch.depth !== undefined || fetch.tags)) {
    const parts = [
      fetch.filter === 'none' ? '完整对象' : `--filter=${filterArg(fetch.filter)}`,
      fetch.depth === undefined ? '完整历史' : `--depth=${fetch.depth}`,
      fetch.tags ? '带标签' : '不带标签',
    ]
    add(
      'fetch',
      fetch.filter === 'tree' || fetch.depth !== undefined ? 'warn' : 'info',
      `抓取策略：${parts.join(' · ')}`,
      fetch.filter === 'tree'
        ? 'treeless 抓取会让计划逐个回源取对象，目录多时通常比 blob 慢'
        : fetch.depth !== undefined
          ? `浅抓取只影响本工具拉取的上游引用，但会让 ${config.companyBranch} 之外的历史在本地的这一段变短，并关闭改名识别`
          : undefined,
    )
  }
  if (fetch?.depth !== undefined && facts?.git && await facts.git.isShallow())
    add('shallow', 'warn', `本地仓库已是浅仓库（depth=${fetch.depth}）`, '需要完整历史时执行 git fetch --unshallow，或去掉 fetchConfig.depth 后重新抓取')
  if (fetch?.lfs === 'materialize') {
    if (await lfsAvailable(cwd))
      add('lfs', 'pass', 'git-lfs 可用：LFS 指针会被替换成真实文件内容')
    else
      add('lfs', 'warn', 'fetchConfig.lfs 为 materialize，但本机没有 git-lfs', '安装 git-lfs，或改成 lfs: pointer（只同步指针文本）')
  }
  else if (fetch?.lfs === 'off') {
    add('lfs', 'info', 'fetchConfig.lfs 为 off：不检测 Git LFS，指针文本静默落地', '需要同步二进制资产时改成 pointer（报出指针）或 materialize（取回内容）')
  }

  // 日志落盘：写不进去的日志等于没有日志，所以这条判断的是目录和文件到底能不能追加，
  // 而不是配置字符串写得对不对。doctor 自己不往运维的日志里塞探测行。
  const logFile = config.logConfig?.file?.trim()
  if (logFile) {
    const resolved = path.resolve(cwd, logFile)
    const failure = checkAppendable(resolved)
    if (failure) {
      add('log-file', 'fail', `日志文件不可写：${resolved}（${failure}）`, '检查目录权限与磁盘空间，或去掉 --log-file / logConfig.file')
    }
    else {
      const size = fs.existsSync(resolved) ? fs.statSync(resolved).size : 0
      const maxBytes = config.logConfig?.maxBytes ?? DEFAULT_LOG_CONFIG.maxBytes
      const keep = config.logConfig?.keep ?? DEFAULT_LOG_CONFIG.keep
      add(
        'log-file',
        size > maxBytes ? 'warn' : 'info',
        `日志同时写入 ${resolved}（当前 ${Math.round(size / 1024)} KiB · 超过 ${Math.round(maxBytes / 1024)} KiB 轮转 · 保留 ${keep} 份）`,
        size > maxBytes ? '本次检查会把文件推到轮转，先确认历史日志还要不要留' : undefined,
      )
    }
  }

  // 投递审计：daemon 的唯一事后凭证，值得单独一条。
  if (config.webhookConfig?.enable) {
    const deliveryLog = config.webhookConfig.deliveryLog?.trim()
    if (!deliveryLog) {
      add('webhook-log', 'warn', 'webhook 已开启，但没有设置 deliveryLog', '加上后每收到一次投递就追加一行 JSONL，进程退出也还能回看')
    }
    else {
      const resolved = path.resolve(cwd, deliveryLog)
      const failure = checkAppendable(resolved)
      if (failure) {
        add('webhook-log', 'fail', `投递审计不可写：${resolved}（${failure}）`, '检查目录权限与磁盘空间')
      }
      else {
        const tail = readDeliveryLog(resolved, 1)
        if (tail.total === 0)
          add('webhook-log', 'info', `投递审计还没有记录：${resolved}`, '收到第一条投递后才会出现内容')
        else
          add('webhook-log', 'pass', `投递审计已有 ${tail.total} 条，最近一条「${tail.records[0]?.decision}」${tail.records[0]?.reason ? `（${tail.records[0].reason}）` : ''} · ${tail.records[0]?.at ?? ''}`)
      }
    }
    const maxQueue = config.webhookConfig.maxQueue ?? 8
    add('webhook-queue', 'info', `同步队列上限 ${maxQueue}：排满后新投递回 503，让平台稍后重投`, '上游推送很密时加大它，或让 daemon 只监听受保护分支')
  }

  if (config.prConfig?.enable) {
    const remoteName = config.prConfig.remote ?? '（目标分支的上游，否则 origin）'
    add('pr-mode', 'info', `PR 模式：改动推到 ${remoteName} 上的自动分支，目标分支 ${config.companyBranch} 不改动，也不写增量状态`)
    const remoteUrl = facts?.git ? await facts.git.remoteUrl(config.prConfig.remote ?? 'origin').catch(() => undefined) : undefined
    const tool = toolForRemote(remoteUrl, config.prConfig.tool)
    if (config.prConfig.create === 'never')
      add('pr-cli', 'info', `prConfig.create=never：只推送分支并给出对比链接，不调用 ${tool}`)
    else if (await findPrTool(tool, cwd))
      add('pr-cli', 'pass', `检测到 ${tool}，PR 模式会自动开 PR`)
    else
      add('pr-cli', 'warn', `未检测到 ${tool}，PR 只会推送分支并打印对比链接`, `安装 ${tool}，或设置 prConfig.tool / prConfig.create: never`)
  }

  const counts: Record<CheckLevel, number> = { pass: 0, warn: 0, fail: 0, info: 0 }
  for (const check of checks) counts[check.level]++
  const blocking = counts.fail

  const data: DoctorReport = { repo: facts?.repo ?? null, checks, counts, blocking }
  const origin = facts
    ? facts.sources.map(item => item.source.label).join(' + ')
    : (config.upstreamBranch || '?')
  const lines = [
    bold(cyan(`sync-upstream doctor · ${origin} → ${config.companyBranch || '?'}`)),
    ...checks.map(check => `${MARK[check.level](SIGN[check.level])} ${bold(check.id.padEnd(18))} ${check.message}${check.hint ? dim(`\n      ↳ ${check.hint}`) : ''}`),
    '',
    `${MARK.pass(`通过 ${counts.pass}`)} · ${MARK.warn(`警告 ${counts.warn}`)} · ${MARK.fail(`失败 ${counts.fail}`)} · ${MARK.info(`提示 ${counts.info}`)}`,
    blocking > 0 ? red('有阻塞问题，同步很可能失败；按上面的提示逐项处理。') : green('没有阻塞问题。'),
  ]

  return {
    report: toReport('doctor', data, { ok: blocking === 0, exitCode: blocking > 0 ? 1 : 0, summary: doctorMarkdown(data) }),
    lines,
  }
}

/** Markdown table for CI logs; doctor output is the first thing a failing pipeline should show. */
export function doctorMarkdown(data: DoctorReport): string {
  const rows = data.checks.filter(check => check.level !== 'pass')
  if (rows.length === 0)
    return `### sync-upstream doctor\n\n所有 ${data.counts.pass} 项检查通过。`
  return [
    '### sync-upstream doctor',
    '',
    '| 级别 | 检查项 | 说明 |',
    '| --- | --- | --- |',
    ...rows.map(check => `| ${check.level} | \`${check.id}\` | ${check.message.replace(/\|/g, '\\|')}${check.hint ? ` · ${check.hint.replace(/\|/g, '\\|')}` : ''} |`),
  ].join('\n')
}
