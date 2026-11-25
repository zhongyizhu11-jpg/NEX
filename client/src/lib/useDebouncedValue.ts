import { useEffect, useState } from "react";

/**
 * 输入框的值过一会儿再给查询用。
 *
 * 搜索框、自定义规则文本框这些，键是整段文本，每敲一个键就是一次请求：
 * 这里停手 delayMs 之后才把值放出去，配合 placeholderData 保住上一轮结果，
 * 表格就不会在两次请求之间闪一下「加载中」。
 *
 * 原来 Tickets、AuditTab 各自抄了一份，收到这里来。
 */
export function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
