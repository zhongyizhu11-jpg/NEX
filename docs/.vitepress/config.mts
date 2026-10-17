import { defineConfig } from "vitepress";

const base = process.env.VITEPRESS_BASE || "/";

export default defineConfig({
  base,
  lang: "zh-CN",
  title: "NEX",
  description: "NEX 转发管理面板用户教程",
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ["meta", { name: "theme-color", content: "#0f766e" }],
    ["meta", { name: "referrer", content: "strict-origin-when-cross-origin" }],
  ],
  themeConfig: {
    siteTitle: "NEX 教程",
    logo: "/nex-logo.png",
    nav: [
      { text: "快速开始", link: "/guide/quick-start" },
      { text: "部署面板", link: "/guide/deploy-panel" },
      { text: "功能使用", link: "/guide/rules" },
      { text: "常见问题", link: "/guide/troubleshooting" },
      { text: "GitHub", link: "https://github.com/zhongyizhu11-jpg/NEX" },
    ],
    sidebar: [
      {
        text: "开始使用",
        items: [
          { text: "教程概览", link: "/guide/" },
          { text: "快速开始", link: "/guide/quick-start" },
          { text: "部署前准备", link: "/guide/preparation" },
          { text: "部署面板", link: "/guide/deploy-panel" },
          { text: "环境变量", link: "/guide/env-vars" },
          { text: "首次初始化", link: "/guide/first-setup" },
        ],
      },
      {
        text: "基础功能",
        items: [
          { text: "安装 Agent", link: "/guide/agent" },
          { text: "主机管理", link: "/guide/hosts" },
          { text: "转发规则", link: "/guide/rules" },
          { text: "流量和延迟", link: "/guide/traffic-latency" },
          { text: "网络拓扑", link: "/guide/topology" },
          { text: "链路诊断", link: "/guide/link-diagnostics" },
          { text: "监控与告警", link: "/guide/monitoring-alerts" },
        ],
      },
      {
        text: "链路和高可用",
        items: [
          { text: "隧道链路", link: "/guide/tunnels" },
          { text: "端口转发链", link: "/guide/port-chains" },
          { text: "线路组", link: "/guide/failover" },
          { text: "转发组和入口出口组", link: "/guide/groups" },
          { text: "DDNS 和故障转移", link: "/guide/ddns" },
          { text: "自动换 IP", link: "/guide/auto-ip-change" },
          { text: "PROXY Protocol", link: "/guide/proxy-protocol" },
          { text: "共享 TLS 入站（SNI 分流）", link: "/guide/sni-shared-inbound" },
          { text: "落地主机与 Shadowsocks 出口", link: "/guide/ss-egress" },
          { text: "限速、复制模式与 SOCKS5", link: "/guide/rate-limits" },
        ],
      },
      {
        text: "用户和维护",
        items: [
          { text: "用户、套餐和权限", link: "/guide/users-billing" },
          { text: "邀请返利", link: "/guide/referrals" },
          { text: "Telegram 和通知", link: "/guide/notifications" },
          { text: "工单", link: "/guide/tickets" },
          { text: "Google 登录", link: "/guide/google-login" },
          { text: "Discord 登录和通知", link: "/guide/discord" },
          { text: "升级和备份", link: "/guide/upgrade-backup" },
          { text: "卸载 NEX", link: "/guide/uninstall" },
          { text: "常见问题排查", link: "/guide/troubleshooting" },
        ],
      },
    ],
    outline: {
      level: [2, 3],
      label: "本页目录",
    },
    docFooter: {
      prev: "上一页",
      next: "下一页",
    },
    lastUpdated: {
      text: "最后更新",
      formatOptions: {
        dateStyle: "medium",
        timeStyle: "short",
      },
    },
    search: {
      provider: "local",
      options: {
        translations: {
          button: {
            buttonText: "搜索文档",
            buttonAriaLabel: "搜索文档",
          },
          modal: {
            displayDetails: "显示详细列表",
            resetButtonTitle: "清除搜索",
            backButtonTitle: "关闭搜索",
            noResultsText: "没有找到结果",
            footer: {
              selectText: "选择",
              selectKeyAriaLabel: "回车",
              navigateText: "切换",
              navigateUpKeyAriaLabel: "上箭头",
              navigateDownKeyAriaLabel: "下箭头",
              closeText: "关闭",
              closeKeyAriaLabel: "ESC",
            },
          },
        },
      },
    },
    socialLinks: [{ icon: "github", link: "https://github.com/zhongyizhu11-jpg/NEX" }],
  },
});
