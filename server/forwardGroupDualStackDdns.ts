/*
  转发组 / 入口组的双栈 DDNS（上游 2.3.294「入口组、转发组 DDNS 支持 IPv4 + IPv6」）。

  原来一个组只发一种记录（A、AAAA 或 CNAME）。双栈打开后（forward_groups.ddnsDualStack），A 组同时发
  AAAA、AAAA 组同时发 A —— 但**成员挑选、健康判定、故障切换、带宽聚合一律还按主记录类型来**，
  另一族只是「跟着同一批成员走」：主记录选中了哪些成员，副记录就发这些成员的另一族地址。

  为什么不让两族各挑各的：故障转移组切走一台坏机器时，A 换到了 B，AAAA 要是还指着 A，
  双栈客户端优先连 IPv6，照样连到坏机器上 —— 切换等于没切。所以副记录必须严格跟随，选中的成员没有
  另一族地址时就少一条，一条都没有时把副记录清空（不是保留旧值，理由同上）。

  CNAME 组没有「另一族」，不支持双栈。
*/

export type ForwardGroupDdnsRecordType = "A" | "AAAA" | "CNAME";

/** 双栈组的副记录类型；没开双栈或者是 CNAME 组返回 null。 */
export function forwardGroupMirrorRecordType(group: { recordType?: unknown; ddnsDualStack?: unknown } | null | undefined): "A" | "AAAA" | null {
  const dual = group?.ddnsDualStack === true || group?.ddnsDualStack === 1 || group?.ddnsDualStack === "1";
  if (!dual) return null;
  const recordType = String(group?.recordType || "A").trim().toUpperCase();
  if (recordType === "A") return "AAAA";
  if (recordType === "AAAA") return "A";
  return null;
}

/**
 * 主记录发了这些值，副记录该发什么：按主记录的次序，把每个值对应成员的另一族地址列出来（去重）。
 * pairs 是组里每个成员的（主族地址, 另一族地址）。主记录里出现、却找不到成员的值（比如手动解析留下的）跳过。
 */
export function mirrorForwardGroupDdnsValues(primaryValues: string[], pairs: Array<{ primary: string; mirror: string }>): string[] {
  const out: string[] = [];
  for (const value of primaryValues) {
    const primary = String(value || "").trim();
    if (!primary) continue;
    for (const pair of pairs) {
      const mirror = String(pair.mirror || "").trim();
      if (String(pair.primary || "").trim() === primary && mirror && !out.includes(mirror)) out.push(mirror);
    }
  }
  return out;
}

/** 组配置能不能开双栈：只有发 A / AAAA 的故障转移组、入口组。 */
export function forwardGroupSupportsDualStack(groupMode: unknown, recordType: unknown) {
  const mode = String(groupMode || "");
  const type = String(recordType || "A").toUpperCase();
  return (mode === "entry" || mode === "failover") && (type === "A" || type === "AAAA");
}
