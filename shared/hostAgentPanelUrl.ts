/*
  主机独立的 Agent 面板连接地址（见 server/hostAgentPanelUrl.ts）。界面和服务端共用的门槛。

  Agent 从这一版起，收到新的面板地址会先用自己的 Token 做一次认证探测，通了才切换并落盘；
  更旧的 Agent 收到就直接切，所以面板只给够新的 Agent 发独立地址。
*/
export const HOST_AGENT_PANEL_URL_AGENT_VERSION = "2.2.255";
