# 官方主题库

这里是随面板发布的界面主题包。面板自带经典、珍珠、液态玻璃三套；这里的几套不随页面加载，管理员在
「系统设置 › 个性化 › 主题管理 › 官方主题库」里点一下才安装。构建时整个 `official/` 目录拷到
`dist/themes/official`（见 `esbuild.config.mjs`），所以安装不需要外网。

现在有五套：

| id | 名字 | 来历 |
| --- | --- | --- |
| `deepspace` | 深空 | 原来内置，2.3.525 挪进主题库 |
| `gilt` | 墨金 | 同上 |
| `rose` | 玫瑰 | 同上 |
| `cinnabar` | 朱砂 | 同上 |
| `indigo` | 靛蓝 | 同上 |

每套一个目录，目录名就是主题 id：

```text
official/<id>/theme.json   清单：id、名字、版本、说明、预览色
official/<id>/theme.css    样式：每条规则都写在 html[data-ui-theme="<id>"] 下面
```

改了某一套的样式，记得把它 `theme.json` 里的 `version` 调大：已经装着这套的站点会在主题库里看到「可更新」。

加一套新的官方主题：建目录、写清单和样式，再把 id 加进 `shared/uiThemePackage.ts` 的 `OFFICIAL_UI_THEME_IDS`
（`shared/uiThemePackage.test.ts` 会核对目录和名单对得上）。

格式说明、限制和第三方主题的做法见使用文档的「界面主题」一页（`docs/guide/themes.md`）。
