/**
 * GB ↔ 字节，以及输入框里那个字符串。
 *
 * 用 1000 而不是 1024：机房卖的「1000G」是按 1000 算的，按 1024 存进去再显示出来
 * 会变成 931G，跟你填的数对不上。
 *
 * 抽出来共用是因为填这个数的地方不止一处（粘贴节点的套餐、自建端口的额度）。
 * 两处各写一份的话，同一个字节数会在两个弹窗里显示成不同的 GB —— 而人只会以为
 * 面板算错了。
 */
const GB_IN_BYTES = 1e9;

/** 输入框里的 GB 字符串 → 字节。空、非数字、非正数一律当「没填」。 */
export function bytesFromGb(value: unknown): number {
  const gb = Number(String(value ?? "").trim());
  if (!Number.isFinite(gb) || gb <= 0) return 0;
  return Math.round(gb * GB_IN_BYTES);
}

/** 字节 → 输入框里的 GB 字符串。0 显示成空串，让占位符去说「没填」。 */
export function gbFromBytes(bytes: unknown): string {
  const value = Number(bytes) || 0;
  if (value <= 0) return "";
  const gb = value / GB_IN_BYTES;
  // 大数取整、小数留两位：1000G 不该显示成 1000.00，而 1.5G 不能被抹成 2。
  return String(gb >= 100 ? Math.round(gb) : Number(gb.toFixed(2)));
}

/** 输入框里的整数（带宽、重置日）。空或非法当 0。 */
export function positiveIntFromInput(value: unknown): number {
  const parsed = Math.floor(Number(String(value ?? "").trim()));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
