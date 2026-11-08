/* 线路组这几个文件内部共用的小函数。拆开之前它们就不对外，shared/routeGroup.ts 也不导出它们。 */

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function truthy(value: unknown, fallback: boolean) {
  if (value === null || value === undefined) return fallback;
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}
