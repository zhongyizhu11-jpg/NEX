/**
 * 几类查询共用的 React Query 选项。
 *
 * 同一个查询在不同页面各写一套 staleTime（trafficBilling.configs 这边 30 s、那边 5 s；
 * users.options 一处 60 s、一处默认 0），后果是两处同时挂着时各拉各的 —— 缓存键一样，
 * 新鲜期不一样，短的那个到期就重取，长的那个白等。这里定成名字，调用处只说「这是哪一类」。
 *
 * 只放选项对象，不包 hook：trpc 的 useQuery 第二个参数直接展开就行，类型由调用处推。
 */

/**
 * 下拉选项类的名单（users.options / hosts.options / plans.options）。
 * 一分钟内不重拉、切回窗口也不拉：这种名单变化慢，而且往往在弹窗里取，
 * 开一次弹窗就打一次服务器没有意义。
 */
export const optionsQuery = {
  staleTime: 60_000,
  refetchOnWindowFocus: false,
} as const;

/**
 * 整站配置 / 设置的快照（trafficBilling.configs、proxySubscriptions.settingsPublic 这类）。
 * 半分钟内按缓存走：改设置的那一侧保存后会定向失效，不靠轮询发现变化。
 */
export const configQuery = {
  staleTime: 30_000,
  refetchOnWindowFocus: false,
} as const;

