/*
  手机上「整页比屏幕宽」的现场排查（2026-11-04）。

  用户的 iPhone 上整页布局宽度比屏幕多出约 9px（卡片左边距 12、右边距只剩 3，底栏也偏），
  Chromium、WebKit 模拟都复现不出来 —— 多半是只有真机才有的字体宽度或系统行为。
  地址栏里带上 ?fxlayout（例如 https://面板/rules?fxlayout）打开，顶上浮一块小面板：
  视口 / 布局 / 页面三个宽度，以及右边超出屏幕的元素（标签、类名、左右坐标），截个图就能定位。

  不带这个参数时什么都不做：不挂监听、不占渲染。
*/

const PANEL_ID = "fx-layout-probe";

function describe(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const cls = typeof (el as HTMLElement).className === "string"
    ? (el as HTMLElement).className.split(/\s+/).filter(Boolean).slice(0, 3).join(".")
    : "";
  const slot = el.getAttribute("data-slot");
  return `${tag}${cls ? "." + cls : ""}${slot ? `[${slot}]` : ""}`.slice(0, 80);
}

function insideScroller(el: Element): boolean {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const ox = getComputedStyle(p).overflowX;
    if (ox === "auto" || ox === "scroll") return true;
  }
  return false;
}

function collect(): string {
  const screenW = window.screen?.width || 0;
  const vv = window.visualViewport;
  const root = document.documentElement;
  const limit = Math.min(screenW || window.innerWidth, window.innerWidth);
  const lines = [
    `screen ${screenW} · inner ${window.innerWidth} · client ${root.clientWidth} · scroll ${root.scrollWidth} · body ${document.body.scrollWidth}`,
    vv ? `visual ${Math.round(vv.width * 10) / 10} · scale ${Math.round(vv.scale * 1000) / 1000} · left ${Math.round(vv.offsetLeft)}` : "visual —",
  ];
  const offenders: { text: string }[] = [];
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    if (el.id === PANEL_ID || el.closest(`#${PANEL_ID}`)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || r.right <= limit + 0.5) continue;
    if (insideScroller(el)) continue;
    const pos = getComputedStyle(el).position;
    offenders.push({ text: `${describe(el)} ${pos === "static" ? "" : pos + " "}L${Math.round(r.left)} R${Math.round(r.right)} W${Math.round(r.width)}` });
  }
  // 文档顺序里父元素在子元素前面，前几条就是最外层的那几个
  lines.push(offenders.length ? `超出右边的元素 ${offenders.length} 个：` : "没有元素超出右边");
  lines.push(...offenders.slice(0, 12).map((item) => item.text));
  return lines.join("\n");
}

function render() {
  let panel = document.getElementById(PANEL_ID);
  if (!panel) {
    panel = document.createElement("pre");
    panel.id = PANEL_ID;
    panel.setAttribute("aria-hidden", "true");
    Object.assign(panel.style, {
      position: "fixed",
      top: "env(safe-area-inset-top, 0px)",
      left: "0",
      width: "100%",
      maxWidth: "100%",
      boxSizing: "border-box",
      margin: "0",
      padding: "6px 8px",
      font: "10px/1.35 ui-monospace, Menlo, monospace",
      whiteSpace: "pre-wrap",
      wordBreak: "break-all",
      color: "#fff",
      background: "rgb(0 0 0 / 82%)",
      zIndex: "2147483647",
      pointerEvents: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(panel);
  }
  panel.textContent = collect();
}

export function startLayoutProbeIfRequested() {
  if (typeof window === "undefined") return;
  let wanted = false;
  try {
    wanted = new URLSearchParams(window.location.search).has("fxlayout");
  } catch {
    wanted = false;
  }
  if (!wanted) return;
  const tick = () => {
    try {
      render();
    } catch {
      // 排查工具自己出错不能影响页面
    }
  };
  window.setTimeout(tick, 1500);
  window.setInterval(tick, 2000);
}
