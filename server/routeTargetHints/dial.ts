import type { RouteTargetHint } from "./types";

/**
 * 拨号地址：Agent 要拨的那个地址（没中转拨落地，有中转拨第一跳上那条中继规则的入口）。
 * 解析不出来的路径（中转离线、没端口）**照样占一个下标**，填一个拨不通的占位地址、标成用不了（down.ts）：
 * Agent 那边健康、样本、连接都按下标记，少发一条会让后面的全部错位。
 */
export const dialHint: RouteTargetHint = {
  name: "dial",
  fields: ({ dial }) => (dial
    ? { targetIp: dial.ip, targetPort: dial.port }
    : { targetIp: "127.0.0.1", targetPort: 1 }),
};
