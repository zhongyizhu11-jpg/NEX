import { RouteBoardList } from "./RouteBoardList";

/*
  链路管理页的「线路总览」里的线路组一节 —— 线路板：每条线路组一张卡，卡里一条路径一条链
  （入口 ─ 中转… ─ 落地），段上写延迟、节点下写速率、在走的那条流着小点。实现在 RouteBoardList，
  规则卡上的线路组弹窗画的是同一套路径卡。
*/
export function RouteGroupsSection({ searchQuery = "", isAdmin = false }: { searchQuery?: string; isAdmin?: boolean }) {
  return <RouteBoardList searchQuery={searchQuery} isAdmin={isAdmin} />;
}
