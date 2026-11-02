/*
  按键排队：同一个键的任务一个接一个跑，不同键之间互不影响。

  给「先查后改」用：查出现状、判断、再写回去这几步要连成一气，中间不能插进同一个键的另一次。
  只在这一个面板进程里有效 —— 面板本来就是单进程（限流、缓存都在内存里）。
*/

export function createKeyedSerial<K>() {
  const tails = new Map<K, Promise<unknown>>();
  return async function runSerial<T>(key: K, task: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) || Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    try {
      return await run;
    } finally {
      // 后面没人排队了就把键删掉，免得 Map 只增不减。
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}
