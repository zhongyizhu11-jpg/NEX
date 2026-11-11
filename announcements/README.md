# 开发者公告

面板在「检查更新」时会读 `feed.json`（和检查更新同一个开关、同一个 GitHub 加速站，最多半小时一次），把适用于自己版本、还没发过的条目插进「公告」。每条只插一次：管理员删掉或停用的不会被放回来。

```json
{
  "announcements": [
    {
      "id": "2026-11-security-jwt",
      "title": "请检查 JWT_SECRET",
      "content": "支持 Markdown / 安全 HTML，和面板里发公告一样。",
      "type": "normal",
      "maxVersion": "2.3.523",
      "expiresAt": "2026-12-31T00:00:00Z"
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 必填，小写字母、数字、连字符，3～64 个字符，发出去以后不要改 |
| `title` / `content` | 必填；标题最多 120 字，正文最多 10000 字 |
| `type` | `normal`（普通公告，默认）、`popup`（登录弹窗，会顶掉当前那个）、`upgrade_popup`（升级弹窗，要配 `targetVersion`） |
| `minVersion` / `maxVersion` | 只发给这个版本范围里的面板，例如只提醒还停在旧版本的 |
| `startsAt` / `expiresAt` | ISO 时间或秒；过期的不再插 |

最多读前 20 条，写错的条目会被整条跳过。
