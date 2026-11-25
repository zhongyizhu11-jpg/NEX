import { isDatabaseTransactionActive } from "./dbRuntime";

/*
  几条互不依赖的只读查询一起发。

  事务外各用池里一条连接，真并行；事务里只有一条连接：pg 对同一个 client 上并发的 query() 只是排队、
  并且会警告「上一条还没执行完又调了 query()」（pg 9 要去掉这种用法），mysql2 的连接同样一条一条执行。
  所以事务里按顺序 await，结果形状不变 —— 调用方不用知道自己此刻是不是在事务里（getDb 会按上下文给事务的连接）。
*/
export async function readAll<const T extends readonly (() => PromiseLike<unknown>)[]>(
  thunks: T,
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  type Results = { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
  if (!isDatabaseTransactionActive()) return (await Promise.all(thunks.map((thunk) => thunk()))) as unknown as Results;
  const results: unknown[] = [];
  for (const thunk of thunks) results.push(await thunk());
  return results as unknown as Results;
}

/** readAll 的 map 版：事务里按顺序，事务外并行。 */
export async function mapReads<T, R>(items: readonly T[], mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!isDatabaseTransactionActive()) return Promise.all(items.map((item, index) => mapper(item, index)));
  const results: R[] = [];
  for (let index = 0; index < items.length; index += 1) results.push(await mapper(items[index], index));
  return results;
}
