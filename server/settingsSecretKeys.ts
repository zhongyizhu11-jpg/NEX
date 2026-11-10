/*
  系统设置（system_settings）里哪些键存的是密钥 —— 这些键的值落库时加密，见 server/settingsEncryption.ts。

  名单是照代码里真实读写的键一个个找出来的（设置页 system.updateSettings、DDNS、邮件、Telegram、
  Discord、Google 登录、AI、支付、异地备份、运维 Webhook）。加一个新的密钥类设置，记得加到这里；
  漏加不会出错，只是那一项照旧明文存。

  不在名单里的：各家的 AccessKeyId / SecretId 之外的「账号名」类字段（单独拿到没用）、Bot 用户名、
  Webhook 方法这类配置项；主机安全基线令牌（ops.hostSecurity.baselineToken.*，只是一个防重复的随机串）。
*/

export const SECRET_SETTING_LABELS: Readonly<Record<string, string>> = {
  panelSslKeyPem: "面板 HTTPS 私钥",
  ddnsWebhookUrl: "DDNS Webhook 地址",
  ddnsWebhookHeaders: "DDNS Webhook 请求头",
  ddnsCloudflareApiToken: "DDNS · Cloudflare API Token",
  ddnsAliyunAccessKeySecret: "DDNS · 阿里云 AccessKey Secret",
  ddnsHuaweiCloudSecretKey: "DDNS · 华为云 SecretKey",
  ddnsTencentCloudSecretKey: "DDNS · 腾讯云 SecretKey",
  emailPassword: "邮件 SMTP 密码",
  telegramBotToken: "Telegram 机器人 Token",
  discordBotToken: "Discord 机器人 Token",
  discordClientSecret: "Discord 登录 Client Secret",
  googleClientSecret: "Google 登录 Client Secret",
  deepseekApiKey: "AI API Key",
  deepseekApiKeyDeepseek: "AI API Key（DeepSeek）",
  deepseekApiKeySiliconflow: "AI API Key（硅基流动）",
  deepseekApiKeyCustom: "AI API Key（自定义）",
  paymentConfig: "支付配置（商户密钥、私钥）",
  "ops.backup.webdav.password": "异地备份 · WebDAV 密码",
  "ops.backup.s3.secretKey": "异地备份 · S3 Secret Key",
  "ops.backup.passphrase": "异地备份 · 备份密码",
  "ops.webhook.url": "运维 Webhook 地址",
  "ops.metrics.token": "指标导出 · 抓取口令",
};

export const SECRET_SETTING_KEYS: ReadonlySet<string> = new Set(Object.keys(SECRET_SETTING_LABELS));

export function isSecretSettingKey(key: unknown): boolean {
  return SECRET_SETTING_KEYS.has(String(key || ""));
}

export function secretSettingLabel(key: string): string {
  return SECRET_SETTING_LABELS[key] || key;
}
