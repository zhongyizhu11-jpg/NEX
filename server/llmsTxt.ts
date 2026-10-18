import express from "express";
import { MCP_TOOLS } from "./ops/mcp";
import { getSetting } from "./repositories/settingsRepository";
import { APP_VERSION } from "../shared/versions";

/*
  GET /llms.txt —— 给 AI 助手看的说明书（llms.txt 约定：站点根目录一份 Markdown）。

  把这个面板的 /llms.txt 地址丢给 Claude、ChatGPT 之类的助手，它就知道 NEX 是什么、
  资源之间什么关系、怎么用 API 令牌接 MCP、有哪些工具、排障先调哪个。

  这里只有通用说明和工具清单，不含这个面板的任何数据（主机、规则、用户都不写），所以公开。
  面板地址优先用设置里的公开地址，没有就用这次请求的地址。
*/

function panelOrigin(req: express.Request, configured: string | null) {
  const value = String(configured || "").trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(value)) return value;
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return host ? `${proto}://${host}` : "";
}

export function buildLlmsTxt(origin: string) {
  const base = origin || "<面板地址>";
  const toolLines = MCP_TOOLS.map((tool) => {
    const tags = [tool.mutation ? "会改动" : "只读", tool.adminOnly ? "仅管理员" : ""].filter(Boolean).join("，");
    return `- \`${tool.name}\`（${tags}）：${tool.description}`;
  });
  return [
    "# NEX",
    "",
    `> NEX 是一个多主机端口转发与隧道管理面板（面板 ${APP_VERSION}）。每台服务器上跑一个 Agent，面板下发转发规则、隧道和转发组，并收集流量、延迟和在线状态。`,
    "",
    "## 资源是怎么连起来的",
    "",
    "- **主机**：装了 Agent 的服务器。离线的主机上的规则不会生效。",
    "- **规则**：一个入口端口转到一个目标地址。规则可以直接挂在主机上（端口转发），也可以走隧道或转发组。",
    "- **隧道**：入口主机到出口主机的加密通道（可以有中间跳）；规则从入口进、从出口出去连目标。",
    "- **转发组**：端口转发（一组入口）、主备 / 负载组（多条线路自动切换）、转发链（多跳）、入口组、出口组。",
    "  转发组的成员可以设「可用时段」，时段外这条线路不参与转发。",
    "- 一条规则不通，通常按这个顺序查：规则是否启用 → 沿线主机是否在线 → 端口是否冲突 → 目标地址能否解析 / 连上 → 隧道是否在跑。",
    "",
    "## 通过 MCP 接入",
    "",
    `- 地址：\`${base}/mcp\`（Streamable HTTP，POST JSON-RPC，回 application/json）。`,
    "- 认证：`Authorization: Bearer <个人 API 令牌>`。令牌在面板「设置 › 进阶 › API 令牌与 MCP」里创建。",
    "- **只做排查时请用只读令牌**：只读令牌调不了任何会改动的工具和接口。",
    "- 令牌碰不到改密码、双重验证、通行密钥、登录设备和令牌管理，这些只能在网页上操作。",
    "- 返回给 AI 的数据会去掉令牌、密码、密钥类字段，长文本和长列表会截断。",
    "",
    "Claude Code 的配置示例：",
    "",
    "```json",
    "{",
    '  "mcpServers": {',
    '    "nex": {',
    '      "type": "http",',
    `      "url": "${base}/mcp",`,
    '      "headers": { "Authorization": "Bearer nex_..." }',
    "    }",
    "  }",
    "}",
    "```",
    "",
    "## 工具",
    "",
    ...toolLines,
    "",
    "## 排障建议",
    "",
    "1. 用户说「某条规则 / 隧道 / 转发链不通」：先 `get_fault_bundle`（只读，不打扰主机），看 `panelChecks` 里 status 为 fail / warn 的项和 `hosts` 里离线的主机。",
    "2. 需要主机实测（端口在不在听、目标连不连得上）时再用 `diagnose_rule`（会让主机跑一次检测，需要可写令牌）。",
    "3. 管理员排查整体问题：`get_fault_board` 看正在告警的项目，`get_events` 看最近发生了什么。",
    "4. 改动类操作（停用规则、建规则、重置流量）只在用户明确要求时做。",
    "",
  ].join("\n");
}

export const llmsTxtRouter = express.Router();

llmsTxtRouter.get("/llms.txt", async (req, res) => {
  const configured = await getSetting("panelPublicUrl").catch(() => null);
  res
    .status(200)
    .type("text/markdown; charset=utf-8")
    .set("Cache-Control", "public, max-age=300")
    .send(buildLlmsTxt(panelOrigin(req, configured)));
});
