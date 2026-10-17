/*
  「珍珠」主题（theme-pearl.css）首页标题右边那两样：上游 Forwardx 仪表盘的日期铭牌（深色等宽字小牌）
  和「系统在线」绿边胶囊。只由首页在 data-ui-theme="pearl" 时渲染，别的主题不出现。
  「系统在线」和上游一样是固定的一句：页面能读到数据，面板就是在线的；真正的状况在下面的统计和「需要关注」里。
*/
export default function PearlHeaderBadges() {
  const today = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "short", day: "numeric" });
  return (
    <div className="fx-pearl-header-badges">
      <span className="fx-pearl-spec-plate">{today}</span>
      <span className="fx-pearl-online">系统在线</span>
    </div>
  );
}
