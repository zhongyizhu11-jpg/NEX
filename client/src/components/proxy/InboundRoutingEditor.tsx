import { Plus, Route, Trash2 } from "lucide-react";
import {
  INBOUND_ROUTE_PRESETS,
  INBOUND_ROUTE_TARGET_LABELS,
  INBOUND_ROUTE_TARGETS,
  MAX_INBOUND_ROUTES,
  parseRouteDomains,
  type InboundRoute,
  type InboundRouteTargetType,
} from "@shared/inboundRouting";
import { UNLOCK_STATUS_LABELS, type UnlockStatus } from "@shared/unlockCheck";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

/** 表单里的一条分流：域名先按文本编辑（换行 / 逗号分隔），保存时再拆。 */
export type InboundRouteForm = {
  presets: string[];
  domainsText: string;
  target: InboundRouteTargetType;
  landingInboundId: number;
};

export function inboundRoutesToForm(routing: { routes?: InboundRoute[] } | null | undefined): InboundRouteForm[] {
  return (routing?.routes || []).map((route) => ({
    presets: [...route.presets],
    domainsText: route.domains.join("\n"),
    target: route.target,
    landingInboundId: route.landingInboundId,
  }));
}

export function inboundRoutesFromForm(routes: readonly InboundRouteForm[]) {
  return {
    routes: routes.map((route) => ({
      presets: route.presets,
      domains: route.domainsText.split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean),
      target: route.target,
      landingInboundId: route.target === "landing" ? route.landingInboundId : 0,
    })),
  };
}

const STATUS_TONE: Record<string, string> = {
  ok: "text-[var(--fx-healthy-text)]",
  partial: "text-[var(--fx-warn-text)]",
  blocked: "text-[var(--fx-down-text)]",
  unknown: "text-muted-foreground",
};

/**
 * 节点编辑器里的「分流」：按服务或域名，把这个端口的一部分流量从别的落地出去（shared/inboundRouting.ts）。
 *
 * 默认收着：多数节点不需要。有分流时标题上写几条，列表行上会显示每条实际去了哪。
 * 「走另一台落地」的下拉里每台落地后面带着所选服务的最新检测结论，选之前就知道它解不解锁。
 */
export function InboundRoutingEditor({ routes, onChange, hostId, status }: {
  routes: InboundRouteForm[];
  onChange: (routes: InboundRouteForm[]) => void;
  /** 这个节点所在的主机：自己不能当自己的分流出口，下拉里不列。 */
  hostId: number;
  /** 已保存的节点：每条分流现在实际去了哪（服务端解析的结果）。 */
  status?: Array<{ note: string; action: string }>;
}) {
  const landingOptions = trpc.proxyInbounds.routingLandingOptions.useQuery(undefined, {
    enabled: routes.some((route) => route.target === "landing"),
    staleTime: 30_000,
  });
  const update = (index: number, patch: Partial<InboundRouteForm>) => {
    onChange(routes.map((route, i) => (i === index ? { ...route, ...patch } : route)));
  };
  const togglePreset = (index: number, id: string) => {
    const current = routes[index].presets;
    update(index, { presets: current.includes(id) ? current.filter((item) => item !== id) : [...current, id] });
  };

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <Label className="flex items-center gap-1.5"><Route className="h-3.5 w-3.5" />分流</Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            按服务或域名把一部分流量从别的落地出去，其余照旧直连。比如这台不解锁 Netflix，就让 Netflix 走解锁的那台。
          </p>
        </div>
        {routes.length < MAX_INBOUND_ROUTES ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => onChange([...routes, { presets: [], domainsText: "", target: "auto_unlock", landingInboundId: 0 }])}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />加一条
          </Button>
        ) : null}
      </div>

      {routes.map((route, index) => {
        const domainCount = parseRouteDomains(route.domainsText).length;
        const options = (landingOptions.data || []).filter((option) => option.hostId !== hostId);
        const selected = options.find((option) => option.inboundId === route.landingInboundId);
        const note = status?.[index]?.note;
        return (
          <div key={index} className="space-y-2 rounded-md border bg-muted/30 p-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="flex flex-wrap gap-1" role="group" aria-label={`第 ${index + 1} 条分流的服务`}>
                {INBOUND_ROUTE_PRESETS.map((preset) => {
                  const on = route.presets.includes(preset.id);
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => togglePreset(index, preset.id)}
                      className={cn(
                        "h-6 rounded-full border px-2 text-xs transition-colors",
                        on ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {preset.name}
                    </button>
                  );
                })}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-muted-foreground"
                aria-label={`删除第 ${index + 1} 条分流`}
                onClick={() => onChange(routes.filter((_, i) => i !== index))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <textarea
              aria-label={`第 ${index + 1} 条分流的自定义域名`}
              value={route.domainsText}
              onChange={(event) => update(index, { domainsText: event.target.value })}
              placeholder="自定义域名（可选），一行一个，example.com 同时匹配它的子域名"
              rows={2}
              className="w-full resize-y rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="grid gap-2 sm:grid-cols-2">
              <Select value={route.target} onValueChange={(value) => update(index, { target: value as InboundRouteTargetType })}>
                <SelectTrigger className="h-8" aria-label={`第 ${index + 1} 条分流去哪`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {INBOUND_ROUTE_TARGETS.map((target) => (
                    <SelectItem key={target} value={target}>{INBOUND_ROUTE_TARGET_LABELS[target]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {route.target === "landing" ? (
                <Select
                  value={route.landingInboundId > 0 ? String(route.landingInboundId) : ""}
                  onValueChange={(value) => update(index, { landingInboundId: Number(value) })}
                >
                  <SelectTrigger className="h-8" aria-label={`第 ${index + 1} 条分流走哪台落地`}>
                    <SelectValue placeholder={landingOptions.isLoading ? "加载中…" : options.length ? "选一台落地" : "没有可用的 SS 落地"} />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((option) => (
                      <SelectItem key={option.inboundId} value={String(option.inboundId)}>
                        {option.name}{option.online ? "" : "（离线）"}{option.enabled ? "" : "（已停用）"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </div>
            {route.target === "landing" && selected && route.presets.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                「{selected.name}」最新检测：
                {route.presets.map((id, i) => {
                  const value = (selected.unlock as Record<string, string>)[id] as UnlockStatus | undefined;
                  const name = INBOUND_ROUTE_PRESETS.find((preset) => preset.id === id)?.name || id;
                  return (
                    <span key={id} className={cn(value ? STATUS_TONE[value] : "text-muted-foreground")}>
                      {i > 0 ? "、" : ""}{name} {value ? UNLOCK_STATUS_LABELS[value] : "没测过"}
                    </span>
                  );
                })}
              </p>
            ) : null}
            {route.target === "auto_unlock" ? (
              <p className="text-xs text-muted-foreground">
                {route.presets.length === 0
                  ? "选上要解锁的服务：面板在你能用的 Shadowsocks 落地里挑一台最新检测里这些服务都可用的。"
                  : "每次下发时挑一台在线、最新检测里这些服务都可用的落地；挑不出来就先直连。检测结果变了会自动换。"}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-1 text-meta text-muted-foreground">
              <span>
                {route.presets.length > 0 ? `${route.presets.length} 个服务` : ""}
                {route.presets.length > 0 && domainCount > 0 ? " + " : ""}
                {domainCount > 0 ? `${domainCount} 个域名` : ""}
                {route.presets.length === 0 && domainCount === 0 ? "还没选服务或填域名" : ""}
              </span>
              {note ? <span className={cn(status?.[index]?.action === "block" ? "text-destructive" : "")}>现在：{note}</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
