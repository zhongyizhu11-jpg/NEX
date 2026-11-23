

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
