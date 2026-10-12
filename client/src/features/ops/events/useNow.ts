import { useEffect, useState } from "react";

/** 每分钟走一下的「现在」，让「5 分钟前」这类相对时间不用等下一次拉数据才更新。 */
export function useMinuteNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
