/*
  主机、规则真正删掉之后，通知各模块把按 id 记在内存里的缓存一起清掉。

  这些缓存大多有条数上限或空闲过期，不清也不会无限涨；但删掉的主机 / 规则留着的条目
  会一直占位到过期，同一个 id 以后被复用时还可能读到上一台的旧状态。
  监听器同步执行、互不影响：一个抛错只记一条调试日志。
*/

type Listener = (id: number) => void;

const hostListeners = new Set<Listener>();
const ruleListeners = new Set<Listener>();

export function onHostDeleted(listener: Listener) {
  hostListeners.add(listener);
  return () => hostListeners.delete(listener);
}

export function onRuleDeleted(listener: Listener) {
  ruleListeners.add(listener);
  return () => ruleListeners.delete(listener);
}

function notify(listeners: Set<Listener>, kind: string, value: unknown) {
  const id = Math.floor(Number(value));
  if (!Number.isInteger(id) || id <= 0) return;
  for (const listener of listeners) {
    try {
      listener(id);
    } catch (error) {
      console.debug(`[EntityCleanup] ${kind}=${id} cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function notifyHostDeleted(hostId: unknown) {
  notify(hostListeners, "host", hostId);
}

export function notifyRuleDeleted(ruleId: unknown) {
  notify(ruleListeners, "rule", ruleId);
}
