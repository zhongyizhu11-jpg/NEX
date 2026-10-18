import { useRef, useState, type ReactNode } from "react";
import { MoreHorizontal, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** ⋯ 菜单里的一项。传数据而不是 JSX：两段列表的菜单长得一样才叫协调。 */
export type ProxyNodeRowAction = {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  /** 危险操作排在分隔线之后，并染成警示色。 */
  destructive?: boolean;
};

/**
 * 一行的全部内容，做成数据。
 *
 * 「我的节点」那张卡把自建、粘贴、分享来的三类节点合成了一个列表，而这三类的
 * 开关和动作各写各的字段（自建行的开关写派生节点的 includeDirect，粘贴行写自己
 * 那条记录）。**所以行是由各自的 owner 组装好之后传下来的，不是在列表里按类型
 * 分支** —— 接错线的后果是用户点了开关、界面变了，写下去的却是另一条记录。
 *
 * protocol / sortName 给列表用来分组和排序。
 */
export type ProxyNodeRowSpec = {
  key: string;
  leading?: ReactNode;
  name: ReactNode;
  tag?: ReactNode;
  meta: ReactNode;
  detail?: ReactNode;
  inline?: ReactNode;
  toggle?: ReactNode;
  actions?: ProxyNodeRowAction[];
  muted?: boolean;
  /** 分组用。空串表示未知，会落进「其他」。 */
  protocol?: string;
  /** 组内排序用的纯文本名字。 */
  sortName?: string;
  /**
   * 这条线路是哪来的。左边一道很淡的色条。
   *
   * 三类节点合成一个列表之后，「这是我自己机器上开的、还是粘来的、还是别人给我的」
   * 成了最常要分辨的一件事 —— 它决定了这行能不能改、凭据归谁。原来只写在第二行的
   * 文字里，一眼扫过去全是一样的灰。
   *
   * 只做色条，不把文字也染色：颜色是辅助，文字仍然是那个说清楚的人。色盲、截图转灰、
   * 深色模式下对比度不够，这一行都还能读。
   */
  accent?: ProxyNodeRowAccent;
};

/** own = 自己机器上开的；pasted = 粘进来的；shared = 别人分享给我的。 */
export type ProxyNodeRowAccent = "own" | "pasted" | "shared";

const ACCENT_BORDERS: Record<ProxyNodeRowAccent, string> = {
  // 青：和「我的节点」那段的色章、「落地节点」那张概览卡同色 —— 自建的才是真正属于
  // 这个面板的那一类。
  own: "border-l-[3px] border-l-[color-mix(in_srgb,var(--fx-healthy)_50%,transparent)]",
  // 天蓝：从别处粘来的，凭据不是面板生成的。
  pasted: "border-l-[3px] border-l-[color-mix(in_srgb,var(--fx-path)_50%,transparent)]",
  // 紫：别人给的，只能用不能改。
  shared: "border-l-[3px] border-l-[color-mix(in_srgb,var(--fx-delivery)_50%,transparent)]",
};

/**
 * 节点行的统一骨架，「新建节点」与「落地节点」两段共用。
 *
 * 第一行的规矩：名字 + 最多一个徽章，别的一律放第二行。
 *
 * 这行原本是「名字 + 协议徽章 + 安全徽章 + 停用徽章」，徽章都是 shrink-0 而名字是
 * 唯一能压缩的元素 —— 手机上一行就那么宽，动作按钮每多一个，被吃掉的全是名字，
 * 最后名字只剩一个字。徽章本身不是问题，问题是数量不封顶：只要还能往这行加东西，
 * 下次就会再加一个。
 *
 * 所以放一个就到顶，而且必须是长度有上限的（协议名最长是 Shadowsocks，约 70px）。
 * 要再加第三样东西，加到 meta 里去。
 *
 * 为什么动作收进 ⋯：同样是宽度守恒。行内只留「用量」和开关两个常用的，其余进菜单；
 * 以后再加功能也只是菜单里多一项，不会再挤到名字。
 *
 * 名字和第二行都换行而不截断：手机上一行放不下时，被「…」吃掉的恰好是最要看的部分
 * （地址的端口、归属的账号、名字的后半截）。多占一行比看不全好。
 */
export function ProxyNodeRow({
  leading,
  name,
  tag,
  meta,
  detail,
  inline,
  toggle,
  actions = [],
  muted = false,
  accent,
}: {
  /** 状态点之类的前置标记。 */
  leading?: ReactNode;
  name: ReactNode;
  /** 名字后面那一个徽章。只放长度有上限的东西，协议名这种。 */
  tag?: ReactNode;
  /** 第二行：协议、地址、端口、停用、分享人数……一句话说完，超长就换行。 */
  meta: ReactNode;
  /** 展开后的补充信息（如套餐用量），跟在第二行下面。 */
  detail?: ReactNode;
  /** 开关之前的一个小按钮，留给最常用的那一个。 */
  inline?: ReactNode;
  toggle?: ReactNode;
  /** 来源色条，见 ProxyNodeRowAccent。 */
  accent?: ProxyNodeRowAccent;
  actions?: ProxyNodeRowAction[];
  /** 停用的行整体压暗，不另外占一个徽章的位置。 */
  muted?: boolean;
}) {
  const normal = actions.filter((action) => !action.destructive);
  const destructive = actions.filter((action) => action.destructive);

  /**
   * 菜单项要做的事推迟到菜单真正关完再做。
   *
   * 这里的几项多半会弹一个对话框（确认删除、分享选人、编辑）。菜单和对话框都是
   * Radix 的浮层，在同一拍里一个关一个开，两边的焦点陷阱和 body 上的
   * pointer-events 会打架 —— 表现是对话框弹出来却点不动，或者整页失去响应。
   * 所以先记下来，等 onCloseAutoFocus（关闭动画结束后）再执行。
   */
  const [open, setOpen] = useState(false);
  const pending = useRef<null | (() => void)>(null);

  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 ${
        accent ? ACCENT_BORDERS[accent] : ""
      } ${muted ? "opacity-60" : ""}`}
    >
      {leading}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="min-w-0 break-words text-sm font-medium leading-tight [overflow-wrap:anywhere]">{name}</span>
          {tag}
        </div>
        <p className="break-words text-[11px] leading-snug text-muted-foreground [overflow-wrap:anywhere]">{meta}</p>
        {detail}
      </div>
      {inline}
      {toggle}
      {actions.length > 0 ? (
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" title="更多操作">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-40"
            onCloseAutoFocus={(event) => {
              // 焦点别弹回 ⋯ 按钮：接下来多半有个对话框要接管它。
              event.preventDefault();
              const run = pending.current;
              pending.current = null;
              run?.();
            }}
          >
            {normal.map((action) => (
              <DropdownMenuItem
                key={action.key}
                disabled={action.disabled}
                onSelect={() => { pending.current = action.onSelect; }}
              >
                <action.icon className="mr-2 h-3.5 w-3.5" />
                {action.label}
              </DropdownMenuItem>
            ))}
            {destructive.length > 0 && normal.length > 0 ? <DropdownMenuSeparator /> : null}
            {destructive.map((action) => (
              <DropdownMenuItem
                key={action.key}
                disabled={action.disabled}
                onSelect={() => { pending.current = action.onSelect; }}
                className="text-destructive focus:text-destructive"
              >
                <action.icon className="mr-2 h-3.5 w-3.5" />
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

/** 第二行那句话：把非空段落用 · 串起来，省掉一堆三元表达式。 */
export function proxyNodeMetaText(parts: Array<string | false | null | undefined>): string {
  return parts.filter((part): part is string => !!part && part.trim().length > 0).join(" · ");
}
