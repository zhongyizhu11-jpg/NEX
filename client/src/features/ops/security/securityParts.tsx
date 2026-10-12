import { cn } from "@/lib/utils";

/*
  安全巡检页和主机详情「安全」一节共用的小块：级别徽标、级别 / 状态的中文、证据字段名。
*/

export type Severity = "low" | "medium" | "high" | "critical";

export const SEVERITY_LABEL: Record<Severity, string> = { low: "低", medium: "中", high: "高", critical: "严重" };

/** 颜色只用现有的状态色：严重 / 高 走红，中走黄，低走描边灰。 */
export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  const tone = severity === "critical" || severity === "high"
    ? "bg-[var(--fx-down-soft)] text-[var(--fx-down-text)] border-transparent"
    : severity === "medium"
      ? "bg-[var(--fx-warn-soft)] text-[var(--fx-warn-text)] border-transparent"
      : "border-[var(--fx-stroke-base)] text-[var(--fx-text-secondary)]";
  return (
    <span className={cn("inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11.5px] font-medium leading-4", severity === "critical" && "font-semibold", tone, className)}>
      {SEVERITY_LABEL[severity]}
    </span>
  );
}

export const EVIDENCE_LABELS: Record<string, string> = {
  pid: "进程号",
  comm: "进程名",
  exe: "程序",
  cmdline: "命令行",
  user: "用户",
  uid: "UID",
  shell: "Shell",
  home: "家目录",
  path: "文件",
  proto: "协议",
  port: "端口",
  ip: "来源 IP",
  method: "登录方式",
  keyType: "钥匙类型",
  comment: "钥匙注释",
  keyHash: "钥匙指纹",
  module: "内核模块",
  exec: "启动命令",
  addedLines: "新增内容",
  cpuPercent: "CPU 占用",
  sha256: "SHA256",
  previousSha256: "原 SHA256",
  size: "大小",
  version: "版本",
};

/** 证据按固定顺序排，常看的（进程、文件、来源）在前，哈希这种长串在后。 */
const EVIDENCE_ORDER = ["comm", "pid", "user", "exe", "path", "proto", "port", "ip", "method", "module", "uid", "shell", "home", "keyType", "comment", "cpuPercent", "exec", "cmdline", "addedLines", "size", "version", "keyHash", "sha256", "previousSha256"];

export function evidenceEntries(evidence: Record<string, unknown>) {
  const keys = Object.keys(evidence || {}).filter((key) => evidence[key] !== "" && evidence[key] !== null && evidence[key] !== undefined);
  keys.sort((a, b) => {
    const ia = EVIDENCE_ORDER.indexOf(a);
    const ib = EVIDENCE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return keys.map((key) => {
    const raw = evidence[key];
    let value = Array.isArray(raw) ? raw.join("\n") : String(raw);
    if (key === "cpuPercent") value = `${value}%`;
    if (key === "size") value = formatBytes(Number(raw));
    return { key, label: EVIDENCE_LABELS[key] || key, value, mono: !["comm", "user", "method", "keyType", "comment", "cpuPercent", "size"].includes(key) };
  });
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDateTime(seconds: number | null | undefined) {
  if (!seconds) return "—";
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
