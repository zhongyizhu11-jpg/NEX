import { useEffect, useMemo, useState } from "react";
import { Gauge } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SettingList, SettingRow } from "@/components/SettingRow";
import DataSectionLoading from "@/components/DataSectionLoading";
import DataSectionError from "@/components/DataSectionError";
import { trpc } from "@/lib/trpc";

type LimitKey =
  | "userQueryPerMinute"
  | "userMutationPerMinute"
  | "tokenQueryPerMinute"
  | "tokenMutationPerMinute"
  | "anonymousQueryPerMinute"
  | "anonymousMutationPerMinute";

type Form = { enabled: boolean } & Record<LimitKey, string>;

/** 三行（谁）× 两列（查询 / 修改）。 */
const ROWS: Array<{ label: string; description: string; query: LimitKey; mutation: LimitKey }> = [
  { label: "登录的用户", description: "按账号算，网页和手机 App 共用一份", query: "userQueryPerMinute", mutation: "userMutationPerMinute" },
  { label: "API 令牌", description: "每枚令牌各算各的，MCP 也在内", query: "tokenQueryPerMinute", mutation: "tokenMutationPerMinute" },
  { label: "未登录", description: "按来源 IP 算（IPv6 按 /64）", query: "anonymousQueryPerMinute", mutation: "anonymousMutationPerMinute" },
];

const KEYS: LimitKey[] = ROWS.flatMap((row) => [row.query, row.mutation]);

function toForm(config: { enabled: boolean } & Record<LimitKey, number>): Form {
  const form = { enabled: config.enabled } as Form;
  for (const key of KEYS) form[key] = String(config[key]);
  return form;
}

/**
 * 设置 › 进阶 › 接口限流（批次 1 · 第 2 项）。
 *
 * 每分钟能调多少次接口：按登录用户、API 令牌、未登录 IP 三类，查询和修改分开。
 * 超了回「请求太频繁」（HTTP 429）。默认值是忙碌页面实测的十几倍，正常使用碰不到；0 = 这一项不限。
 * 需要提交的开关用 Checkbox（见 components/ui/checkbox.tsx 的分工说明）。
 */
export default function ApiRateLimitSection(_props: Record<string, never>) {
  const utils = trpc.useUtils();
  const query = trpc.ops.apiRateLimit.get.useQuery();
  const updateMutation = trpc.ops.apiRateLimit.update.useMutation();
  const [form, setForm] = useState<Form | null>(null);
  const saved = query.data?.config;
  const defaults = query.data?.defaults;
  useEffect(() => {
    if (saved) setForm(toForm(saved));
  }, [saved]);

  const dirty = useMemo(() => {
    if (!form || !saved) return false;
    return form.enabled !== saved.enabled || KEYS.some((key) => form[key].trim() !== String(saved[key]));
  }, [form, saved]);

  const invalidKey = form ? KEYS.find((key) => !/^\d+$/.test(form[key].trim())) : undefined;

  const save = async () => {
    if (!form) return;
    if (invalidKey) {
      toast.error("每一项都要填 0 或正整数（0 = 不限）");
      return;
    }
    try {
      const input = { enabled: form.enabled } as { enabled: boolean } & Record<LimitKey, number>;
      for (const key of KEYS) input[key] = Number(form[key].trim());
      const result = await updateMutation.mutateAsync(input);
      utils.ops.apiRateLimit.get.setData(undefined, (current) => (current ? { ...current, config: result.config } : current));
      setForm(toForm(result.config));
      toast.success(result.config.enabled ? "接口限流已保存，立即生效" : "接口限流已关闭");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    }
  };

  const restoreDefaults = () => {
    if (defaults) setForm(toForm(defaults));
  };

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge className="h-4 w-4 text-primary" />
          接口限流
        </CardTitle>
        <CardDescription>每分钟最多调多少次接口，超了提示「请求太频繁」。防止泄露的令牌或写错的脚本把面板拖垮；0 = 这一项不限。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isLoading || !form ? (
          query.error ? (
            <DataSectionError label="接口限流" error={query.error} onRetry={() => query.refetch()} retrying={query.isFetching} minHeight="min-h-[96px]" />
          ) : (
            <DataSectionLoading label="正在加载接口限流" minHeight="min-h-[96px]" />
          )
        ) : (
          <>
            <SettingList>
              <SettingRow
                asLabel
                label="开启接口限流"
                description="关掉后所有接口都不限次数（登录、订阅各自的限流不受影响）"
                control={<Checkbox aria-label="开启接口限流" checked={form.enabled} onCheckedChange={(enabled) => setForm({ ...form, enabled })} />}
              />
            </SettingList>
            <div className="space-y-2" aria-disabled={!form.enabled}>
              <div className="hidden grid-cols-[minmax(0,1fr)_7rem_7rem] gap-3 px-1 text-meta text-muted-foreground sm:grid">
                <span>每分钟</span>
                <span>查询</span>
                <span>修改</span>
              </div>
              {ROWS.map((row) => (
                <div key={row.label} className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-[var(--fx-stroke-weak)] p-3 sm:grid-cols-[minmax(0,1fr)_7rem_7rem] sm:items-center sm:border-0 sm:p-1">
                  <div className="col-span-2 min-w-0 sm:col-span-1">
                    <div className="text-sm font-medium text-foreground">{row.label}</div>
                    <div className="text-meta text-muted-foreground">{row.description}</div>
                  </div>
                  {([["查询", row.query], ["修改", row.mutation]] as const).map(([caption, key]) => (
                    <label key={key} className="flex min-w-0 flex-col gap-1">
                      <span className="text-meta text-muted-foreground sm:sr-only">{caption}</span>
                      <Input
                        inputMode="numeric"
                        aria-label={`${row.label} 每分钟${caption}次数`}
                        aria-invalid={!/^\d+$/.test(form[key].trim()) || undefined}
                        disabled={!form.enabled}
                        value={form[key]}
                        onChange={(event) => setForm({ ...form, [key]: event.target.value.replace(/[^\d]/g, "") })}
                        className="tabular-nums"
                      />
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={restoreDefaults} disabled={updateMutation.isPending}>恢复默认</Button>
              <Button onClick={save} disabled={!dirty || updateMutation.isPending}>{updateMutation.isPending ? "保存中…" : "保存"}</Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
