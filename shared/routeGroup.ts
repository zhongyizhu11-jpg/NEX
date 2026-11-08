/**
 * 线路组：一个入口 + 多条路径 + 一个调度策略。全站唯一一份模型。
 *
 * 上一版的「主备线路」切的是**落地地址**：备用只是一个 `host:port`，要走中转就得另建
 * 一条转发再把它的地址抄进来 —— 用户看到的是「两个独立转发」，而不是「同一个入口后面的
 * 两条路」。线路组把「一条线 = 一个地址」升级成「一条线 = 一条路径」：
 *
 *     转发：美国游戏线路
 *     入口：0.0.0.0:10001
 *     线路组
 *     ├─ A  主线路   HK01 → JP01 → US01:443
 *     └─ B  备用线路 HK02 → SG01 → US01:443
 *     切换策略  ● 自动故障切换 ○ 定时主备 ○ 手动主备 ○ 智能择优 ○ 混合策略 ○ 权重负载
 *
 * 几条定死的语义：
 *
 *   · **入口就是这条规则所在的机器**。客户端连的 IP:端口落在哪台机上，调度层就在哪台机的
 *     Agent 里，所以每条路径的第一跳都从它出发；路径里写的是**中转**（0 到 5 台）和落地。
 *     想让备用从另一台线路机出发，就把那台机写成备用路径的第一个中转。
 *   · **主备只是调度策略，不是转发架构**。六种模式共用同一份路径清单，换模式不用重建路径。
 *   · **切换只改新连接**（平滑切换）。旧连接留在原来那条上，直到它自己结束；要断旧连接
 *     得明确选「强制切换」。
 *   · 路径里的中转由面板在中转机上**按需建中继规则**（见 server/routeGroups.ts），入口
 *     Agent 拿到的仍然是一份「拨哪个地址」的清单（dial）—— Agent 不需要理解路径。
 *
 * 存储：路径存在 forward_rules.routePaths（JSON），策略存在 routeMode 和几列参数上；老的
 * failover* 列由它们**推导**出来（legacyFailoverFields），老 Agent 和老代码照常工作。
 */

/*
  按话题拆成了几个文件，这里统一再导出，引用的地方照旧 import "shared/routeGroup"：
    routeGroupModel   数据模型：路径、策略的类型和取值，存储值规整
    routeGroupText    界面上的说法：模式、分法、切换方式、事件、原因和问题的翻译
    routeGroupPaths   路径：解析 / 序列化、名字、老列推出的路径、拨号地址、对端、出口 IP
    routeGroupPolicy  调度策略：读策略、套模板、下发的分法、落地怎么分、探测间隔
    routeGroupRule    规则 ↔ 线路组：读出、写回、草稿、校验
    routeGroupUtil    上面几个文件内部共用的小函数，不对外，这里不导出
*/
export * from "./routeGroupModel";
export * from "./routeGroupText";
export * from "./routeGroupPaths";
export * from "./routeGroupPolicy";
export * from "./routeGroupRule";
