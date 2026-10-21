import { Database, FileText, Mail, Palette, Send, Settings2, SlidersHorizontal, Webhook } from "lucide-react";

/**
 * 系统设置的分区定义。Settings.tsx（索引页、宽屏左栏、标签条）和手机「更多」页（More.tsx）共用：
 * 2026-10-21 用户要把系统设置里的东西直接搬进「更多」，这里只写一份，两边照着画。
 */
export const settingsTabs = ["system", "telegram", "email", "personalization", "backup", "logs", "advanced", "webhook"] as const;
export type SettingsTab = typeof settingsTabs[number];

/**
 * 设置的分组。
 *
 * 为什么是分组列表而不是横向标签条：标签条的容量是固定的，加到第七个
 * 就开始滚动，加到第十项就没人找得到第十项。而设置是**只会越来越多**的那种
 * 页面。
 *
 * 分组列表没有这个上限：加一项就是多一行。而且它天然说得清层级 ——
 * 「Telegram 和邮箱都是通知」这件事，横向标签条表达不了，分组一眼看得出来。
 */
export const settingsGroups = [
  {
    key: "general",
    header: "通用",
    items: ["system", "personalization", "advanced"],
  },
  {
    key: "notify",
    header: "通知",
    footer: "Telegram 和邮箱都用来发告警、到期提醒和流量提醒。",
    items: ["telegram", "email", "webhook"],
  },
  {
    key: "maintenance",
    header: "维护",
    items: ["backup", "logs"],
  },
] as const;

/*
  每一项管什么。现在宽屏右栏顶上也显示这一句，所以照实际内容写：原来「系统配置」写着
  「数据库」（数据库切换在备份恢复里）、「邮箱设置」写着「邮件模板」（没有模板这回事）。
*/
export const settingsTabDetail: Record<string, string> = {
  system: "面板地址、HTTPS、注册登录、DDNS 与版本升级",
  personalization: "站点名称、Logo、配色、背景与首页",
  telegram: "机器人推送与 AI 助手",
  email: "SMTP 发信、注册验证与提醒邮件",
  backup: "迁移、数据库切换、导出与导入",
  logs: "运行日志与导出",
  advanced: "流量用尽时的处理、维护模式、API 令牌与 MCP",
  webhook: "把告警推到 Discord、Slack 或任意地址",
};

export const settingsTabItems = [
  { value: "system", label: "系统配置", icon: Settings2 },
  { value: "telegram", label: "Telegram", icon: Send },
  { value: "email", label: "邮箱设置", icon: Mail },
  { value: "personalization", label: "个性化配置", icon: Palette },
  { value: "backup", label: "备份恢复", icon: Database },
  { value: "logs", label: "面板日志", icon: FileText },
  { value: "advanced", label: "进阶", icon: SlidersHorizontal },
  { value: "webhook", label: "Webhook", icon: Webhook },
] as const;
