import { useState } from "react";
import { CheckCircle2 } from "lucide-react";

import { ListRow, ListSection } from "@/components/ios/GroupedList";
import type { SystemHealth } from "@/components/SystemStatusHeader";
import { cn } from "@/lib/utils";

/*
  新装的面板，总览页第一件事告诉管理员「下一步做什么」。

  原来刚装好的面板打开总览，看到的是一排 0：0 台主机、0 条转发、流量图空着。每个数都对，
  可没有一个说「接下来该干嘛」—— 第一次用的人得自己猜：先去主机管理？还是先建规则？
  建规则时又发现没有主机可选。

  三步就能让第一条转发跑起来，按顺序列出来，做完一步勾一步，点哪一步就去哪一页。
  数据就是顶上状态条用的那份 health，不另发请求。三步都做完、或者点了「不再显示」，
  整块就不出现 —— 熟手不需要它一直占着首页。只给管理员看：租户不装主机，他们的
  第一步是管理员给的。
*/

export type QuickStartStep = {
  key: "host" | "online" | "rule";
  title: string;
  /** 一行说完，分组列表的说明行会截断 */
  detail: string;
  done: boolean;
  href: string;
};

export function buildQuickStartSteps(health: Pick<SystemHealth, "hosts" | "forwards">): QuickStartStep[] {
  return [
    {
      key: "host",
      title: "添加一台主机",
      detail: "生成安装命令，贴到你的服务器上运行",
      done: health.hosts.total > 0,
      href: "/hosts",
    },
    {
      key: "online",
      title: "等主机上线",
      detail: "装好后一般几秒内就显示在线",
      done: health.hosts.online > 0,
      href: "/hosts",
    },
    {
      key: "rule",
      title: "新建第一条转发",
      detail: "选这台主机，填目标地址和端口就行",
      done: health.forwards.total > 0,
      // Rules 页认这个参数：打开就直接弹出「添加转发规则」
      href: "/rules?create=local",
    },
  ];
}

const DISMISS_KEY = "forwardx.dashboard.quickStartDismissed";

function readDismissed() {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function QuickStartSection({
  health,
  isAdmin,
  onOpen,
  dense = false,
}: {
  health: SystemHealth | undefined;
  isAdmin: boolean;
  onOpen: (href: string) => void;
  /** 精简布局：三步折成一行「快速开始 · 已完成 n/3 ｜ 下一步 ›」，点了去下一步 */
  dense?: boolean;
}) {
  const [dismissed, setDismissed] = useState(readDismissed);
  // 数据没回来时不画：先闪一下「0 台主机，快去添加」，再发现其实有 20 台，最糟。
  if (!isAdmin || !health || dismissed) return null;
  const steps = buildQuickStartSteps(health);
  if (steps.every((step) => step.done)) return null;
  const doneCount = steps.filter((step) => step.done).length;
  const current = steps.find((step) => !step.done);

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // 存不下就只在这一次打开里藏起来
    }
  };

  if (dense && current) {
    const currentIndex = steps.indexOf(current) + 1;
    return (
      <ListSection>
        <ListRow
          icon={(
            <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full border border-foreground text-[11px] font-semibold tabular-nums text-foreground">
              {currentIndex}
            </span>
          )}
          label={`快速开始 · 已完成 ${doneCount}/${steps.length}`}
          value={current.title}
          onSelect={() => onOpen(current.href)}
        />
      </ListSection>
    );
  }

  return (
    <ListSection
      header={`快速开始 · 已完成 ${doneCount}/${steps.length}`}
      footer={(
        <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={dismiss}>
          不再显示
        </button>
      )}
    >
      {steps.map((step, index) => (
        <ListRow
          key={step.key}
          icon={step.done ? (
            <CheckCircle2 className="h-5 w-5 text-[var(--fx-healthy)]" aria-label="已完成" />
          ) : (
            <span
              aria-hidden="true"
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-full border text-[11px] font-semibold tabular-nums",
                step === current ? "border-foreground text-foreground" : "border-[var(--fx-stroke)] text-muted-foreground",
              )}
            >
              {index + 1}
            </span>
          )}
          label={step.title}
          detail={step.done ? "已完成" : step.detail}
          onSelect={step.done ? undefined : () => onOpen(step.href)}
        />
      ))}
    </ListSection>
  );
}
