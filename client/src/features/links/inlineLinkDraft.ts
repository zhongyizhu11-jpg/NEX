/** 对应要建的线路种类 */
export type LinkKind = "tunnel" | "portGroup" | "chainGroup" | "failoverGroup";

export type LinkKindSpec = {
  kind: LinkKind;
  /** 迷你表单的标题 */
  label: string;
  /** 一句话说清这条线路是什么，给第一次见到这个词的人看 */
  hint: string;
  /** 至少要选几台机器 */
  minHosts: number;
  /** 最多几台。端口转发只在一台机器上开端口，所以是 1 */
  maxHosts: number;
  /** 每一格机器的名字。超出这个数组长度的用最后一个 */
  hostLabels: string[];
  /** 「再加一格」按钮上写什么。maxHosts 是 1 或已经填满时不显示 */
  addSlotLabel: string;
};

const SPECS: Record<LinkKind, LinkKindSpec> = {
  tunnel: {
    kind: "tunnel",
    label: "新建隧道",
    hint: "流量从入口机加密送到出口机，再转到目标。两台机器之间是一条隧道。",
    minHosts: 2,
    maxHosts: 2,
    hostLabels: ["入口机", "出口机"],
    addSlotLabel: "",
  },
  portGroup: {
    kind: "portGroup",
    label: "新建端口转发",
    hint: "在一台机器上开一个端口，直接转到目标，中间不经过别的机器。",
    minHosts: 1,
    maxHosts: 1,
    hostLabels: ["转发机"],
    addSlotLabel: "",
  },
  chainGroup: {
    kind: "chainGroup",
    label: "新建转发链",
    hint: "流量按顺序经过多台机器，每一跳都换一次线路。",
    minHosts: 2,
    maxHosts: 8,
    hostLabels: ["第一跳", "第二跳", "下一跳"],
    addSlotLabel: "再加一跳",
  },
  failoverGroup: {
    kind: "failoverGroup",
    label: "新建主备线路",
    hint: "一组机器，正常走第一台，它出问题自动切到下一台。",
    minHosts: 2,
    maxHosts: 8,
    hostLabels: ["主线路", "备用线路", "再备用"],
    addSlotLabel: "再加一条备用",
  },
};

export function linkKindForRouteMode(routeMode: string): LinkKind | null {
  switch (routeMode) {
    case "tunnel":
      return "tunnel";
    case "local":
      return "portGroup";
    case "chain":
      return "chainGroup";
    case "group":
      return "failoverGroup";
    default:
      return null;
  }
}

export function describeLinkKind(kind: LinkKind): LinkKindSpec {
  return SPECS[kind];
}

/** 第 index 格机器叫什么 */
export function hostSlotLabel(kind: LinkKind, index: number): string {
  const labels = SPECS[kind].hostLabels;
  return labels[Math.min(index, labels.length - 1)];
}

/**
 * 这组机器该用哪种 DNS 记录。
 *
 * 主备线路靠 DDNS 把域名指到当前生效的那台机器上，所以整组必须用同一种记录
 * 类型，而记录类型又决定了成员必须有哪种地址。服务端会拦：
 * 「转发组使用 A 记录时，所有启用成员都需要配置 IPv4」。
 *
 * 写死成 A 的后果是：一台只有 IPv6 的机器永远建不成组，而且**要等到点了创建
 * 才知道**。按实际选中的机器推断就没有这个问题 —— 全都有 IPv4 走 A，全都有
 * IPv6 走 AAAA，两者都不满足才是真的配不出来，那时再说。
 */
export type HostAddresses = { ipv4?: string | null; ipv6?: string | null };

export function resolveGroupRecordType(
  members: HostAddresses[],
): "A" | "AAAA" | null {
  if (members.length === 0) return null;
  const has = (value: string | null | undefined) =>
    typeof value === "string" && value.trim() !== "";
  if (members.every((m) => has(m.ipv4))) return "A";
  if (members.every((m) => has(m.ipv6))) return "AAAA";
  return null;
}

export type LinkDraft = {
  name: string;
  /** 按顺序选的机器。顺序有意义：隧道是入口→出口，转发链是跳序，主备是优先级 */
  hostIds: Array<number | null>;
};

export function emptyLinkDraft(kind: LinkKind): LinkDraft {
  const spec = SPECS[kind];
  return {
    name: "",
    hostIds: Array.from({ length: spec.minHosts }, () => null),
  };
}

/**
 * 草稿能不能提交。
 *
 * 返回一句人话，而不是 true/false —— 按钮旁边要写清楚还差什么，
 * 「创建」按钮变灰但不说为什么，是最让人恼火的一种交互。
 */
export function validateLinkDraft(
  kind: LinkKind,
  draft: LinkDraft,
  /** 选中机器的地址，用来提前发现「这组机器凑不出同一种记录类型」 */
  addressesById?: Map<number, HostAddresses>,
): string | null {
  const spec = SPECS[kind];
  if (!draft.name.trim()) return "给这条线路起个名字";
  if (draft.name.trim().length > 128) return "名字最多 128 个字";

  const chosen = draft.hostIds.filter(
    (id): id is number => typeof id === "number" && id > 0,
  );
  if (chosen.length < spec.minHosts) {
    return spec.minHosts === 1
      ? `还要选 ${spec.hostLabels[0]}`
      : `还要选满 ${spec.minHosts} 台机器`;
  }
  if (chosen.length > spec.maxHosts) return `最多 ${spec.maxHosts} 台机器`;

  /*
    同一台机器不能在一条线路里出现两次。隧道两端都是同一台 = 自己连自己；
    转发链里重复 = 流量绕回去。这两种都是建完之后才发现跑不通的配置，
    在这里就拦住。
  */
  if (new Set(chosen).size !== chosen.length)
    return "同一台机器不能在这条线路里出现两次";

  /*
    主备线路要靠 DDNS 把域名指到当前生效的那台机器，整组得用同一种记录类型。
    在这里就说清楚，而不是让人点了创建之后才被服务端顶回来。
  */
  if (kind === "failoverGroup" && addressesById) {
    const members = chosen
      .map((id) => addressesById.get(id))
      .filter((a): a is HostAddresses => !!a);
    if (
      members.length === chosen.length &&
      resolveGroupRecordType(members) === null
    ) {
      return "这几台机器没有共同的 IP 类型：主备线路要么都有 IPv4，要么都有 IPv6";
    }
  }
  return null;
}

/** 隧道的建线路请求体。没列出来的字段服务端都有默认值 */
export function buildTunnelCreateInput(draft: LinkDraft) {
  const [entryHostId, exitHostId] = draft.hostIds;
  return {
    name: draft.name.trim(),
    entryHostId: Number(entryHostId),
    exitHostId: Number(exitHostId),
    /*
      listenPort 传 0 让服务端自己挑一个没被占的端口。这里不问用户要端口号 ——
      他此刻想的是「从哪台到哪台」，隧道监听在哪个端口是实现细节，要改去线路
      管理页改。
    */
    listenPort: 0,
  };
}

/** 三种转发组的建线路请求体 */
export function buildForwardGroupCreateInput(
  kind: LinkKind,
  draft: LinkDraft,
  addressesById?: Map<number, HostAddresses>,
) {
  const groupMode =
    kind === "portGroup"
      ? "port"
      : kind === "chainGroup"
        ? "chain"
        : "failover";
  const chosen = draft.hostIds.filter(
    (id): id is number => typeof id === "number" && id > 0,
  );
  const recordType = addressesById
    ? resolveGroupRecordType(chosen.map((id) => addressesById.get(id) || {}))
    : null;
  return {
    name: draft.name.trim(),
    groupMode,
    groupType: "host" as const,
    /*
      记录类型跟着选中的机器走，不写死 A —— 写死 A 的话，一台只有 IPv6 的
      机器永远建不成组。推不出来时不传，让服务端用它自己的默认值和报错。
    */
    ...(recordType ? { recordType } : {}),
    /*
      members 的顺序就是 priority：转发链按它决定跳序，主备按它决定谁是主。
      下标当优先级，不另外问一遍。
    */
    members: chosen.map((hostId, index) => ({
      memberType: "host" as const,
      hostId,
      priority: index,
      isEnabled: true,
    })),
  };
}

/**
 * 这种线路要不要管理员才能建。
 *
 * 转发组三兄弟（端口转发 / 转发链 / 主备）在服务端是 adminProcedure，隧道是
 * protectedProcedure。租户看到一个点下去必然报 403 的「＋ 新建」，比看不到
 * 更糟 —— 所以按这个把入口藏掉，同时告诉他该找谁。
 */
export function linkKindRequiresAdmin(kind: LinkKind): boolean {
  return kind !== "tunnel";
}
