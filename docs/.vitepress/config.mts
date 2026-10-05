import { defineConfig } from 'vitepress'

interface GuideSidebarLabels {
  getStarted: string
  quickStart: string
  installation: string
  configFile: string
  vsFork: string
  using: string
  usage: string
  syncBasics: string
  conflicts: string
  gray: string
  webhook: string
  automation: string
}

function guideSidebar(prefix: string, t: GuideSidebarLabels) {
  return [
    {
      text: t.getStarted,
      collapsed: false,
      items: [
        { text: t.quickStart, link: `${prefix}/guide/quick-start` },
        { text: t.installation, link: `${prefix}/guide/installation` },
        { text: t.configFile, link: `${prefix}/guide/configuration` },
        { text: t.vsFork, link: `${prefix}/guide/vs-fork-sync` },
      ],
    },
    {
      text: t.using,
      collapsed: false,
      items: [
        { text: t.usage, link: `${prefix}/guide/usage` },
        { text: t.syncBasics, link: `${prefix}/guide/sync-basics` },
        { text: t.conflicts, link: `${prefix}/guide/conflicts` },
        { text: t.gray, link: `${prefix}/guide/gray-release` },
        { text: t.webhook, link: `${prefix}/guide/webhook` },
        { text: t.automation, link: `${prefix}/guide/automation` },
      ],
    },
  ]
}

const zhTheme = {
  nav: [
    { text: '首页', link: '/' },
    { text: '快速开始', link: '/guide/quick-start' },
    { text: '指南', link: '/guide/usage' },
    { text: '参考', link: '/reference/cli' },
    { text: '更新日志', link: '/changelog' },
    { text: '功能记录', link: '/features' },
    { text: '常见问题', link: '/faq' },
  ],
  sidebar: {
    '/guide/': guideSidebar('', {
      getStarted: '上手',
      quickStart: '快速开始',
      installation: '安装指南',
      configFile: '配置文件',
      vsFork: '与 fork 同步的对比',
      using: '使用',
      usage: '使用总览',
      syncBasics: '日常同步',
      conflicts: '冲突处理',
      gray: '灰度发布与回滚',
      webhook: 'Webhook 守护模式',
      automation: 'CI 与自动化',
    }),
    '/reference/': [
      {
        text: '参考',
        items: [
          { text: '命令行参考', link: '/reference/cli' },
          { text: '配置参考', link: '/reference/configuration' },
          { text: 'API 参考', link: '/reference/api' },
        ],
      },
    ],
    '/': [
      {
        text: '项目',
        items: [
          { text: '更新日志', link: '/changelog' },
          { text: '功能记录', link: '/features' },
          { text: '常见问题', link: '/faq' },
        ],
      },
    ],
  },
  outline: { label: '本页目录' },
  docFooter: { prev: '上一页', next: '下一页' },
  lastUpdatedText: '最后更新',
  darkModeSwitchLabel: '外观',
  returnToTopLabel: '回到顶部',
  sidebarMenuLabel: '菜单',
}

const enTheme = {
  nav: [
    { text: 'Home', link: '/en/' },
    { text: 'Quick start', link: '/en/guide/quick-start' },
    { text: 'Guide', link: '/en/guide/usage' },
    { text: 'Reference', link: '/en/reference/cli' },
    { text: 'Changelog', link: '/en/changelog' },
    { text: 'Features', link: '/en/features' },
    { text: 'FAQ', link: '/en/faq' },
  ],
  sidebar: {
    '/en/guide/': guideSidebar('/en', {
      getStarted: 'Get started',
      quickStart: 'Quick start',
      installation: 'Installation',
      configFile: 'Configuration file',
      vsFork: 'vs. built-in fork sync',
      using: 'Using it',
      usage: 'Overview',
      syncBasics: 'Everyday sync',
      conflicts: 'Conflicts',
      gray: 'Gray release and rollback',
      webhook: 'Webhook daemon',
      automation: 'CI and automation',
    }),
    '/en/reference/': [
      {
        text: 'Reference',
        items: [
          { text: 'CLI reference', link: '/en/reference/cli' },
          { text: 'Configuration reference', link: '/en/reference/configuration' },
          { text: 'API reference', link: '/en/reference/api' },
        ],
      },
    ],
    '/en/': [
      {
        text: 'Project',
        items: [
          { text: 'Changelog', link: '/en/changelog' },
          { text: 'Features', link: '/en/features' },
          { text: 'FAQ', link: '/en/faq' },
        ],
      },
    ],
  },
  outline: { label: 'On this page' },
  docFooter: { prev: 'Previous page', next: 'Next page' },
  lastUpdatedText: 'Last updated',
}

export default defineConfig({
  base: '/sync-upstream/',
  head: [
    ['link', { rel: 'icon', href: '/sync-upstream/favicon.ico' }],
  ],
  title: 'sync-upstream',
  description: '把上游仓库的指定目录同步到你的分支：可预览、可灰度、可回滚。',

  themeConfig: {
    logo: '/sync-upstream-logo.svg',
    search: {
      provider: 'local',
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/flow-zy/sync-upstream.git' },
    ],
  },

  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      themeConfig: zhTheme,
    },
    en: {
      label: 'English',
      lang: 'en-US',
      title: 'sync-upstream',
      description: 'Sync selected directories from an upstream repository: previewable, gradual, reversible.',
      themeConfig: enTheme,
    },
  },
})
