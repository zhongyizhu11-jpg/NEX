import { useMemo, useRef } from "react";

/*
  列表轮询回来时「没变的那几行沿用上一轮的对象」。

  React Query 默认的结构共享（replaceEqualDeep）只认普通对象和数组：superjson 还原出来的 Date
  每轮都是新对象，它一律当成「变了」—— 于是带 createdAt / updatedAt 的每一行、连同整个数组，
  每次轮询都换了引用。下游按引用比较的 useMemo、React.memo 的卡片就全都白做（规则页、主机页
  一轮询整屏的卡都重画）。这里按 id 对上一轮，内容一样（Date 按时间比）就把旧对象拿回来；
  一行都没变、顺序也没变，连数组都还是上一轮那个。
*/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 两份数据内容是否一样：普通对象 / 数组逐项比，Date 按时间比，其余按 Object.is。 */
export function sameDataDeep(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameDataDeep(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && sameDataDeep(a[key], b[key]));
  }
  return false;
}

/**
 * 按 key 把这一轮的行和上一轮对上：内容没变的行换回上一轮的对象；全都没变且顺序一样时返回上一轮的数组。
 * 纯函数版本，给 useStableRows 和测试用。
 */
export function reuseStableRows<T>(
  previous: { rows: T[]; byKey: Map<unknown, T> } | null,
  rows: T[],
  getKey: (row: T) => unknown,
): { rows: T[]; byKey: Map<unknown, T> } {
  const byKey = new Map<unknown, T>();
  let unchanged = !!previous && previous.rows.length === rows.length;
  const next = rows.map((row, index) => {
    const key = getKey(row);
    const old = previous?.byKey.get(key);
    const value = old !== undefined && sameDataDeep(old, row) ? old : row;
    byKey.set(key, value);
    if (unchanged && previous!.rows[index] !== value) unchanged = false;
    return value;
  });
  return unchanged ? { rows: previous!.rows, byKey } : { rows: next, byKey };
}

/** 见文件头。rows 是 undefined（还没数据）时原样返回 undefined。getKey 要是稳定的（写在模块里的函数）。 */
export function useStableRows<T>(rows: T[] | undefined, getKey: (row: NoInfer<T>) => unknown): T[] | undefined {
  const previousRef = useRef<{ rows: T[]; byKey: Map<unknown, T> } | null>(null);
  return useMemo(() => {
    if (!rows) return undefined;
    const result = reuseStableRows(previousRef.current, rows, getKey);
    previousRef.current = result;
    return result.rows;
  }, [getKey, rows]);
}
