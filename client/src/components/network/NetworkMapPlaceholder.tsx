/**
 * 「概览」卡片还没到时占住的位置：同样的标题行 + 一块同样高的空白，卡片到了直接盖上，页面不跳。
 * 高度和 NetworkOverview 的画布一致（手机 240 起、桌面最高 360）；只用 Tailwind 的类。
 */
export function NetworkMapCardPlaceholder() {
  return (
    <section aria-label="概览" aria-busy="true" className="fx-netmap-card fx-card-face flex min-w-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-4 pt-3.5">
        <span className="shrink-0 whitespace-nowrap text-primary-type font-semibold text-foreground">概览</span>
      </div>
      <div aria-hidden="true" className="h-[248px] shrink-0 min-[900px]:h-[330px]" />
    </section>
  );
}
