import { Loader2, Rows3 } from "lucide-react";
import { toast } from "sonner";

import { normalizePersonalizationLayout, PERSONALIZATION_LAYOUTS, type PersonalizationLayoutId } from "@shared/personalization";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { segmentedControlClassName, segmentedOptionClassName } from "@/components/ui/segmented";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/*
  设置 › 个性化 › 布局：站点默认的布局密度（标准 / 精简）。点了就存 —— 它不像配色那样要先试看再保存，
  两个值当场就能看出差别，而且每个账号还能在个人资料里自己覆盖。
  画法见 client/src/styles/compact.css，谁说了算见 shared/personalization.ts。
*/
export function LayoutDefaultCard() {
  const utils = trpc.useUtils();
  const { data: settings } = trpc.system.getSettings.useQuery();
  const current = normalizePersonalizationLayout((settings as any)?.personalizationLayout);
  const save = trpc.system.updateSettings.useMutation({
    onSuccess: async (_data, variables) => {
      await Promise.all([utils.system.getSettings.invalidate(), utils.system.publicInfo.invalidate()]);
      toast.success(variables.personalizationLayout === "compact" ? "站点默认已改为精简布局" : "站点默认已改为标准布局");
    },
    onError: (error) => toast.error(error.message || "布局保存失败"),
  });
  const select = (id: PersonalizationLayoutId) => {
    if (id === current || save.isPending) return;
    // 先把两份缓存改掉让界面当场换（LayoutLayer 盯着 publicInfo），存失败 invalidate 会拉回来
    utils.system.publicInfo.setData(undefined, (old: any) => (old ? { ...old, personalizationLayout: id } : old));
    utils.system.getSettings.setData(undefined, (old: any) => (old ? { ...old, personalizationLayout: id } : old));
    save.mutate({ personalizationLayout: id }, { onError: () => { void utils.system.publicInfo.invalidate(); void utils.system.getSettings.invalidate(); } });
  };
  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Rows3 className="h-4 w-4 text-primary" />
          布局
        </CardTitle>
        <CardDescription>
          全站默认的布局。两种只差总览、转发、主机、链路四页：标准按原来的样子，精简按紧凑的方式画。每个账号可以在个人资料里自己选。</CardDescription>
      </CardHeader>
      <CardContent>
        <div className={cn(segmentedControlClassName, "grid max-w-sm grid-cols-2 gap-1")} role="radiogroup" aria-label="站点默认布局">
          {PERSONALIZATION_LAYOUTS.map((layout) => {
            const active = current === layout.id;
            return (
              <button
                key={layout.id}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={!settings || save.isPending}
                title={layout.description}
                onClick={() => select(layout.id)}
                className={segmentedOptionClassName(active, !settings || save.isPending)}
              >
                {save.isPending && save.variables?.personalizationLayout === layout.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {layout.name}
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
