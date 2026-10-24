import type { Locale } from './i18n'
import { bold, cyan } from 'picocolors'
import { SUBCOMMAND_HELP } from './commands'
import { currentLocale } from './i18n'

/**
 * The `--help` screen, in both languages.
 *
 * It is a function and not a constant because the locale is only known after `--lang` and the
 * environment have been read, while this module is imported at startup — a constant would freeze
 * whichever language the process happened to boot in. `__tests__/i18n.test.ts` compares the flag
 * list of the two renderings, so a new switch cannot be documented in one language only.
 */
export function helpText(locale: Locale = currentLocale()): string {
  return locale === 'en' ? helpEn() : helpZh()
}

/** The subcommand table, aligned the same way in both languages. */
function subcommandRows(): string {
  return SUBCOMMAND_HELP.map(item => `  ${item.usage.padEnd(40)}${item.description}`).join('\n')
}

function helpZh(): string {
  return `${bold(cyan('sync-upstream — 目录级上游同步'))}

用法:
  sync-upstream [选项]                        执行一次同步
${subcommandRows()}
  sync-upstream init [--force]                问答式生成配置文件
  sync-upstream completion <bash|zsh|fish>    打印参数补全脚本（重定向到补全目录）

同步选项:
  -r, --repo <url>          上游仓库 URL（可重复，多个即多上游 fan-in）
  -b, --branch <ref>        上游分支 / 标签 / 提交号 (默认取配置或 main)
  -c, --company-branch <分支> 目标分支 (默认 main)
  -d, --dirs <a,b>          要同步的目录，逗号分隔
  -m, --message <文本>       提交消息
  -p, --push                同步后自动推送
  -f, --force / --incremental  强制覆盖 / 仅同步上次以来的变更
  -P, --preview-only        只打印计划，不修改工作区
  -n, --dry-run             同 --preview-only，用于脚本
  -y, --non-interactive     不询问任何问题
  -C, --config <路径>        指定配置文件（读取失败会直接报错）
  -F, --config-format <格式>  生成配置时的格式: json|json5|yaml|toml
  -g, --generate-config     生成默认配置文件后退出
      --ignore <a,b>        追加忽略规则（gitignore 语法）
      --include-types <a,b> 仅同步这些扩展名，如 .ts,.vue
      --conflict-strategy <s> use-source|keep-target|auto-merge|prompt-user|skip
      --delete-policy <p>   上游删掉的本地文件怎么处理: mirror|keep|ask
      --no-delete / --delete  上述策略的简写：保留本地 / 跟随删除
      --rename-threshold <n> 改名识别阈值 1-100（默认 60，即 git 的 --find-renames）
      --no-renames          关闭改名识别，改名按“删除+新增”处理
      --retry-max/-delay/-backoff  网络重试参数
      --concurrency <n>     失败逐文件重试的并发数
      --lock-wait <ms>      等待其它同步释放仓库锁的时间（默认 0 立即报错）

大仓抓取 (只取需要的对象):
      --fetch-filter <f>    部分抓取: none|blob|tree（git 的 --filter，默认 none）
      --fetch-depth <n>     只取最近 n 个提交（git fetch --depth，会让本地仓库变浅）
      --fetch-tags          抓取时一并带上上游标签（默认 --no-tags）
      --no-fetch-tags       显式关闭上面这条
      --lfs <m>             上游用 Git LFS 管理的文件: pointer|materialize|off
      pointer（默认）只同步指针文本；materialize 会用 git-lfs 取回真实内容，需要本机装了 git-lfs
      blob 过滤下改名识别与增量状态照常工作；--fetch-depth 会关闭改名识别
  -gr, --gray-release       启用灰度发布
      --strategy <s>        percentage|directory|file
      --percentage <n>      灰度百分比 (0,100]
      --canary-dirs <a,b>   金丝雀目录
      --file-patterns <a,b> 金丝雀文件模式
      --validation-script <cmd> 灰度校验命令
  -fr, --full-release       发布灰度剩余文件
  -ro, --rollback           回滚最近一次灰度发布
  -uo, --undo               撤销最近一次同步（生成 revert 提交，不改写历史）
  -we, --webhook-enable     以 webhook 守护模式常驻运行
      --webhook-port/-path/-secret/-events/-branch/-host
      --webhook-log <路径>   每收到一次投递就追加一行 JSONL 审计（谁、什么事件、当时怎么决定的）
      --webhook-queue <n>    最多允许几个同步排队等仓库锁，排满后新投递回 503 让平台稍后重投

日志落盘 (守护进程与长跑 CI 用):
      --log-file <路径>      把日志同时写进这个文件（相对路径按当前目录解析）
      --log-level <l>        文件里保留的最低级别: debug|info|warn|error（默认 info）
      --log-json             文件按每行一个 JSON 对象写，方便 jq / 日志采集
      --log-max <bytes>      超过这个大小就轮转（默认 5 MiB）
      --log-keep <n>         保留几份轮转文件，0 表示不留（默认 5）
      --no-log-json          关闭上面这条，回到可读文本
      写入文件前会去掉颜色码，并把 URL 里的账号口令、token=/secret=/Bearer 这类值打码

多上游 (fan-in):
  -r A -r B                 重复 --repo 即把多个上游同步到同一目标分支
      配置文件里写 upstreams: [{ repo, branch, dirs, message }]，未写的字段继承顶层
      每个上游各有独立的抓取远程、增量状态文件与提交；目录重叠时按顺序后者覆盖前者
      多上游暂不支持灰度发布（-gr / -fr / -ro），需要灰度时一次只配一个上游
      -b 也接受标签或提交号；按提交号抓取需要服务端开启 uploadpack.allowAnySHA1InWant

GitOps PR 模式 (改动不动目标分支):
      --pr                  提交到自动生成的分支并推送，产出 PR
      --pr-branch <模式>     分支名，占位符 {target} {date}（默认 sync-upstream/{target}-{date}）
      --pr-remote <名>       推送用的远程（默认目标分支的上游，否则 origin）
      --pr-title <文本>      PR 标题
      --pr-body <文本>       追加到 PR 描述的说明
      --pr-draft             以草稿 PR 创建
      --pr-no-create         只推送分支并给出对比链接，不调用 gh/glab
      需要本机安装 gh / glab 才会真的开 PR；没装时照样推送分支并打印对比链接
      PR 模式与 -P/-n（预览）、分支策略、灰度发布互斥，也不写增量状态

通知:
      --notify <a,b>        结束后播报的渠道: stdout|http|slack|dingtalk|wecom
      --notify-url <url>    通用 HTTP 渠道地址（会自动补上 http 渠道）
      --notify-events <a,b> 哪些结果才播报: success|noop|conflict|failure|undo
      --no-notify           关闭配置文件里开启的通知
      各平台 URL / 加签密钥请写在配置文件，命令行参数在同机进程里可见

语言与补全:
      --lang <zh|en>        本次输出的语言（帮助、错误消息、提示）
      没给时按 SYNC_UPSTREAM_LANG、LC_ALL、LANG、LANGUAGE 依次判定，都没有则用中文
      completion <shell>     输出 bash / zsh / fish 的参数补全脚本
      init                  问答式生成配置文件；--force 才覆盖已有文件，--json 或 -y 下拒绝

通用选项:
      --json                机器输出：stdout 只有一个 JSON 文档（子命令与同步均适用）
      --fetch               status/why 先拉取上游，而不是只看本地快照
      --limit <n>           history 的显示条数（默认 10）
  -V, --verbose / -s, --silent
  -v, --version / -h, --help

退出码: 0 成功 · 1 失败/有失败文件 · 2 配置或参数错误 · 3 git 错误 · 4 用户取消 · 5 仓库被其它同步占用

在 GitHub Actions 里设置 GITHUB_STEP_SUMMARY 后，计划与提交结果会自动追加为步骤摘要。

示例:
  sync-upstream -r https://github.com/org/upstream.git -d src/utils,docs -b main
  sync-upstream -C sync-upstream.json -P
  sync-upstream status --fetch --json
  sync-upstream why src/config/a.ts
  sync-upstream -r https://github.com/org/upstream.git -b v1.8.0 -P   # 只对齐到某个标签
  sync-upstream -r https://github.com/org/base.git -r https://github.com/org/ui-kit.git -d src/config
  sync-upstream -C sync-upstream.json --no-delete          # 上游删掉的文件保留在本地
  sync-upstream -C sync-upstream.json --pr --pr-draft      # 改动进草稿 PR，目标分支不动
  sync-upstream -C sync-upstream.json --fetch-filter blob   # 大仓：不下载文件内容对象
  sync-upstream -C sync-upstream.json --fetch-depth 50 --lfs materialize  # 只取 50 个提交并回取 LFS 内容
  sync-upstream init                                        # 回答几个问题就得到一份配置
  sync-upstream completion bash > ~/.local/share/bash-completion/completions/sync-upstream
  sync-upstream --lang en --help                            # 英文帮助
`
}

function helpEn(): string {
  return `${bold(cyan('sync-upstream — directory-level upstream sync'))}

Usage:
  sync-upstream [options]                     run one sync
${subcommandRows()}
  sync-upstream init [--force]                build a config file by answering questions
  sync-upstream completion <bash|zsh|fish>    print an argument-completion script

Sync options:
  -r, --repo <url>          upstream repository URL (repeatable; several = multi-upstream fan-in)
  -b, --branch <ref>        upstream branch / tag / commit (defaults to config, else main)
  -c, --company-branch <br> target branch (default main)
  -d, --dirs <a,b>          directories to sync, comma-separated
  -m, --message <text>      commit message
  -p, --push                push automatically after the sync
  -f, --force / --incremental  overwrite anyway / sync only what changed since last time
  -P, --preview-only        print the plan without touching the working tree
  -n, --dry-run             same as --preview-only, for scripts
  -y, --non-interactive     ask no questions at all
  -C, --config <path>       config file to read (a read failure fails the run)
  -F, --config-format <f>   format when generating a config: json|json5|yaml|toml
  -g, --generate-config     write a default config file and exit
      --ignore <a,b>        extra ignore rules (gitignore syntax)
      --include-types <a,b> sync only these extensions, e.g. .ts,.vue
      --conflict-strategy <s> use-source|keep-target|auto-merge|prompt-user|skip
      --delete-policy <p>   what to do with files the upstream deleted: mirror|keep|ask
      --no-delete / --delete  short forms of the above: keep local / follow the deletion
      --rename-threshold <n> rename similarity 1-100 (default 60, i.e. git --find-renames)
      --no-renames          disable rename detection; renames become delete+add
      --retry-max/-delay/-backoff  network retry knobs
      --concurrency <n>     how many files the per-file retry may handle at once
      --lock-wait <ms>      how long to wait for another sync to release the repo lock (default 0 = fail now)

Fetching big repositories (download only what is needed):
      --fetch-filter <f>    partial fetch: none|blob|tree (git --filter, default none)
      --fetch-depth <n>     take the last n commits only (git fetch --depth; makes the local repo shallow)
      --fetch-tags          bring upstream tags along (default --no-tags)
      --no-fetch-tags       turn the above off explicitly
      --lfs <m>             files the upstream keeps in Git LFS: pointer|materialize|off
      pointer (default) syncs the pointer text; materialize fetches real contents and needs git-lfs installed
      rename detection and incremental state keep working under the blob filter; --fetch-depth disables renames
  -gr, --gray-release       enable gray (canary) release
      --strategy <s>        percentage|directory|file
      --percentage <n>      gray percentage, in (0,100]
      --canary-dirs <a,b>   canary directories
      --file-patterns <a,b> canary file patterns
      --validation-script <cmd> gray validation command
  -fr, --full-release       release the files gray release held back
  -ro, --rollback           roll back the latest gray release
  -uo, --undo               undo the last sync (revert commit, history is not rewritten)
  -we, --webhook-enable     run permanently as a webhook daemon
      --webhook-port/-path/-secret/-events/-branch/-host
      --webhook-log <path>   append one JSONL line per delivery (who, which event, what we decided)
      --webhook-queue <n>    how many syncs may queue for the repo lock; extra deliveries get 503 so the platform retries

Log file (for daemons and long-running CI):
      --log-file <path>      also write logs to this file (relative paths resolve against the cwd)
      --log-level <l>        lowest level kept in the file: debug|info|warn|error (default info)
      --log-json             write one JSON object per line, for jq / log shippers
      --log-max <bytes>      rotate past this size (default 5 MiB)
      --log-keep <n>         rotated files to keep, 0 keeps none (default 5)
      --no-log-json          turn the above off, back to readable text
      colours are stripped before writing, and credentials in URLs plus token=/secret=/Bearer values are masked

Multi-upstream (fan-in):
  -r A -r B                 repeating --repo syncs several upstreams onto the same target branch
      in the config file write upstreams: [{ repo, branch, dirs, message }]; omitted keys inherit the top level
      each upstream gets its own fetch remote, incremental state file and commit; overlapping dirs are resolved by order
      gray release (-gr / -fr / -ro) is not supported with several upstreams; configure one upstream at a time then
      -b also accepts a tag or a commit; fetching by commit needs uploadpack.allowAnySHA1InWant on the server

GitOps PR mode (the target branch stays untouched):
      --pr                  commit to a generated branch, push it, produce a PR
      --pr-branch <pattern>  branch name, placeholders {target} {date} (default sync-upstream/{target}-{date})
      --pr-remote <name>     remote to push to (defaults to the target branch upstream, else origin)
      --pr-title <text>      PR title
      --pr-body <text>       extra text appended to the PR description
      --pr-draft             create the PR as a draft
      --pr-no-create         push the branch and print the compare link, do not call gh/glab
      the PR is only opened when gh / glab is installed; otherwise the branch is pushed and the link printed
      PR mode conflicts with -P/-n (preview), branchStrategyConfig and gray release, and writes no incremental state

Notifications:
      --notify <a,b>        channels to report to afterwards: stdout|http|slack|dingtalk|wecom
      --notify-url <url>    generic HTTP channel URL (adds the http channel automatically)
      --notify-events <a,b> which outcomes get reported: success|noop|conflict|failure|undo
      --no-notify           disable notifications that the config file turned on
      put platform URLs / signing secrets in the config file: argv is readable to other processes on the machine

Language and completion:
      --lang <zh|en>        language for this run (help, error messages, prompts)
      with no flag it reads SYNC_UPSTREAM_LANG, LC_ALL, LANG, LANGUAGE in that order, defaulting to Chinese
      completion <shell>     print the bash / zsh / fish argument-completion script
      init                  build a config file by answering questions; --force overwrites, refused under --json / -y

General options:
      --json                machine output: stdout carries exactly one JSON document (sync and subcommands)
      --fetch               status/why fetch the upstream instead of using the local snapshot
      --limit <n>           how many history entries to show (default 10)
  -V, --verbose / -s, --silent
  -v, --version / -h, --help

Exit codes: 0 success · 1 failure/some files failed · 2 config or argument error · 3 git error · 4 cancelled by user · 5 repository locked by another sync

In GitHub Actions, setting GITHUB_STEP_SUMMARY appends the plan and the commit result to the step summary.

Examples:
  sync-upstream -r https://github.com/org/upstream.git -d src/utils,docs -b main
  sync-upstream -C sync-upstream.json -P
  sync-upstream status --fetch --json
  sync-upstream why src/config/a.ts
  sync-upstream -r https://github.com/org/upstream.git -b v1.8.0 -P   # align to a tag only
  sync-upstream -r https://github.com/org/base.git -r https://github.com/org/ui-kit.git -d src/config
  sync-upstream -C sync-upstream.json --no-delete          # keep files the upstream deleted
  sync-upstream -C sync-upstream.json --pr --pr-draft      # put the changes in a draft PR
  sync-upstream -C sync-upstream.json --fetch-filter blob   # big repo: skip file contents
  sync-upstream -C sync-upstream.json --fetch-depth 50 --lfs materialize  # 50 commits, with LFS contents
  sync-upstream init                                        # answer a few questions, get a config
  sync-upstream completion bash > ~/.local/share/bash-completion/completions/sync-upstream
  sync-upstream --lang en --help                            # English help
`
}
