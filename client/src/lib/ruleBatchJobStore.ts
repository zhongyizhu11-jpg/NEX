import { useSyncExternalStore } from "react";

/*
  这个浏览器里在盯着哪些规则批量任务（任务号）。右下角的小窗（RuleBatchJobWidget）挂在整个后台布局上，
  按这里的任务号去问服务端进度 —— 换页面、刷新、开新标签页都接得上。
  只存任务号，进度永远以服务端为准；任务被服务端忘掉（做完 10 分钟、面板重启）后小窗会说一声再移除。
*/

const STORAGE_KEY = "forwardx.rules.batchJobs";
const MAX_TRACKED = 10;

let tracked: string[] = read();
const listeners = new Set<() => void>();

function read(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)).slice(-MAX_TRACKED) : [];
  } catch {
    return [];
  }
}

function write(next: string[]) {
  tracked = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 隐私模式等存不了：这个标签页里照样能看进度，只是刷新后接不上。
  }
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    tracked = read();
    for (const listener of listeners) listener();
  });
}

export function trackRuleBatchJob(id: string) {
  if (tracked.includes(id)) return;
  write([...tracked, id].slice(-MAX_TRACKED));
}

export function untrackRuleBatchJob(id: string) {
  if (!tracked.includes(id)) return;
  write(tracked.filter((item) => item !== id));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTrackedRuleBatchJobs() {
  return useSyncExternalStore(subscribe, () => tracked, () => tracked);
}
