/**
 * 「概览」卡片还没到时占住的位置：同样的标题行 + 一块同样高的画布 + 图例那一行的高度，卡片到了直接盖上，
 * 页面不跳。画布高度和 NetworkOverview.overviewHeight 一致（手机 390 宽约 231、桌面封顶 320）；只用 Tailwind 的类。
 */
export function NetworkMapCardPlaceholder() {
  return (
    <section aria-label="概览" aria-busy="true" className="fx-netmap-card fx-card-face flex min-w-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 pb-2.5 pt-3.5">
        <span className="shrink-0 whitespace-nowrap text-primary-type font-semibold text-foreground">概览</span>
      </div>
      <div aria-hidden="true" className="fx-overview-canvas mx-2.5 h-[231px] shrink-0 min-[900px]:h-[320px]" />
      <div aria-hidden="true" className="h-[38px] shrink-0" />
    </section>
  );
}
