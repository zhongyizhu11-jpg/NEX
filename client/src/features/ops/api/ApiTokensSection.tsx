import { useState } from "react";
import { AlertTriangle, Bot, Copy, KeyRound, Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormField } from "@/components/ui/form-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { SettingList, SettingRow } from "@/components/SettingRow";
import DataSectionLoading from "@/components/DataSectionLoading";
import DataSectionError from "@/components/DataSectionError";
import { clipboardNeedsManualCopy, copyTextToClipboard } from "@/lib/clipboard";
import { mobileAuth } from "@/lib/mobileAuth";
import { trpc } from "@/lib/trpc";
import { dateLabel, relativeTimeLabel } from "../account/timeLabel";

type Scope = "read" | "full";
const EXPIRY_OPTIONS = [
  { value: "30", label: "30 天" },
  { value: "90", label: "90 天" },
  { value: "365", label: "1 年" },
  { value: "never", label: "永不过期" },
] as const;

async function copy(text: string, what = "已复制") {
  if (await copyTextToClipboard(text)) {
    toast.success(what);
    return;
  }
  toast.error(clipboardNeedsManualCopy() ? "当前是 http 访问，浏览器限制了剪贴板，请长按选中内容复制" : "复制失败，请手动复制");
}

/** 一段可复制的代码：手机上自动折行，不出横向滚动条。 */
function CopyBlock({ label, text, copyLabel }: { label: string; text: string; copyLabel?: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-meta text-muted-foreground">{label}</span>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2" onClick={() => copy(text, copyLabel)}>
          <Copy className="h-3.5 w-3.5" />
          复制
        </Button>
      </div>
      <code className="block whitespace-pre-wrap break-all rounded-md border bg-background px-3 py-2 font-mono text-xs leading-5">{text}</code>
    </div>
  );
}

/**
 * 设置 › 进阶 › API 令牌与 MCP（#9）。
 *
 * 令牌给脚本和 AI 助手用：带着它调 /api/trpc/<过程> 或接入 /mcp，权限和你本人一样；
 * 「只读」令牌只能查看。令牌永远碰不到令牌本身、密码、2FA、通行密钥和登录设备。
 * 明文只在创建时显示一次，库里只存哈希。
 */
export default function ApiTokensSection(_props: Record<string, never>) {
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();
  const listQuery = trpc.ops.apiTokens.list.useQuery();
  const { data: systemSettings } = trpc.system.getSettings.useQuery();
  const createMutation = trpc.ops.apiTokens.create.useMutation();
  const revokeMutation = trpc.ops.apiTokens.revoke.useMutation();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<Scope>("read");
  const [expiry, setExpiry] = useState<(typeof EXPIRY_OPTIONS)[number]["value"]>("90");
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);

  const panelUrl = (String(systemSettings?.panelPublicUrl || "").trim() || mobileAuth.panelOrigin()).replace(/\/+$/, "");
  const mcpUrl = `${panelUrl}/mcp`;
  const tokenPlaceholder = created?.token || "<令牌>";
  const claudeCommand = `claude mcp add --transport http nex ${mcpUrl} --header "Authorization: Bearer ${tokenPlaceholder}"`;
  const jsonConfig = JSON.stringify({ mcpServers: { nex: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${tokenPlaceholder}` } } } }, null, 2);
  const items = listQuery.data ?? [];

  const openCreate = () => {
    setName("");
    setScope("read");
    setExpiry("90");
    setCreated(null);
    setDialogOpen(true);
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("请给令牌起个名字");
      return;
    }
    try {
      const result = await createMutation.mutateAsync({
        name: trimmed,
        scope,
        expiresInDays: expiry === "never" ? null : Number(expiry),
      });
      setCreated({ token: result.token, name: trimmed });
      await utils.ops.apiTokens.list.invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建失败");
    }
  };

  const handleRevoke = async (item: (typeof items)[number]) => {
    const ok = await confirm({
      title: "撤销令牌",
      description: `「${item.name}」撤销后立刻失效，用它的脚本和 AI 助手会连不上面板。`,
      confirmText: "撤销",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await revokeMutation.mutateAsync({ id: item.id });
      await utils.ops.apiTokens.list.invalidate();
      toast.success("已撤销");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "撤销失败");
    }
  };

  return (
    <>
      <Card className="border-border bg-card">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4 text-primary" />
              API 令牌
            </CardTitle>
            <CardDescription>给脚本和 AI 助手用，权限和你本人一样；「只读」令牌只能查看。</CardDescription>
          </div>
          <Button className="w-full gap-2 sm:w-auto" onClick={openCreate}>
            <Plus className="h-4 w-4" />
            新建令牌
          </Button>
        </CardHeader>
        <CardContent>
          {listQuery.isLoading ? (
            <DataSectionLoading label="正在加载 API 令牌" minHeight="min-h-[72px]" />
          ) : listQuery.error ? (
            <DataSectionError label="API 令牌" error={listQuery.error} onRetry={() => listQuery.refetch()} retrying={listQuery.isFetching} minHeight="min-h-[96px]" />
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有令牌。</p>
          ) : (
            <SettingList>
              {items.map((item) => (
                <SettingRow
                  key={item.id}
                  label={(
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="break-all">{item.name}</span>
                      <Badge variant={item.scope === "full" ? "default" : "secondary"}>{item.scope === "full" ? "完全" : "只读"}</Badge>
                      {item.expired ? <Badge variant="destructive">已过期</Badge> : null}
                    </span>
                  )}
                  description={(
                    <>
                      <span className="font-mono">{item.prefix}…</span>
                      {` · 上次使用 ${relativeTimeLabel(item.lastUsedAt)}${item.lastUsedIp ? `（${item.lastUsedIp}）` : ""}`}
                      {` · ${item.expiresAt ? `${item.expired ? "已于" : ""}${dateLabel(item.expiresAt)}${item.expired ? "过期" : " 到期"}` : "永不过期"}`}
                    </>
                  )}
                  control={(
                    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => handleRevoke(item)} disabled={revokeMutation.isPending}>
                      撤销
                    </Button>
                  )}
                />
              ))}
            </SettingList>
          )}
        </CardContent>
      </Card>

      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="h-4 w-4 text-primary" />
            接入 MCP
          </CardTitle>
          <CardDescription>让 Claude Code 等 AI 助手直接查看主机、规则，或替你启停规则（需要「完全」令牌）。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <CopyBlock label="MCP 地址" text={mcpUrl} copyLabel="地址已复制" />
          <CopyBlock label="Claude Code" text={claudeCommand} copyLabel="命令已复制" />
          <CopyBlock label="其他客户端（JSON 配置）" text={jsonConfig} copyLabel="配置已复制" />
          <p className="text-meta text-muted-foreground">
            脚本也可以带同样的 <span className="font-mono">Authorization</span> 头直接调用 <span className="font-mono break-all">{panelUrl}/api/trpc/&lt;过程名&gt;</span>，例如 <span className="font-mono">rules.listPage</span>。
          </p>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setCreated(null); }}>
        <DialogContent className="sm:max-w-lg">
          {created ? (
            <>
              <DialogHeader>
                <DialogTitle>令牌已创建</DialogTitle>
                <DialogDescription>「{created.name}」的令牌只显示这一次，关掉就看不到了，请现在复制保存。</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <code className="block break-all rounded-md border bg-background px-3 py-2 font-mono text-sm">{created.token}</code>
                <Button className="w-full gap-2" onClick={() => copy(created.token, "令牌已复制")}>
                  <Copy className="h-4 w-4" />
                  复制令牌
                </Button>
                <CopyBlock label="直接接入 Claude Code" text={claudeCommand} copyLabel="命令已复制" />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => { setDialogOpen(false); setCreated(null); }}>我已保存</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>新建 API 令牌</DialogTitle>
                <DialogDescription>令牌能以你的身份调用面板，像密码一样保管。</DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <FormField className="space-y-2">
                  <Label>名字</Label>
                  <Input value={name} maxLength={64} placeholder="例如：Claude Code、备份脚本" onChange={(event) => setName(event.target.value)} />
                </FormField>
                <FormField className="space-y-2">
                  <Label>权限</Label>
                  <Select value={scope} onValueChange={(value) => setScope(value as Scope)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="read">只读 —— 只能查看</SelectItem>
                      <SelectItem value="full">完全 —— 能修改，和你本人一样</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>
                <FormField className="space-y-2">
                  <Label>有效期</Label>
                  <Select value={expiry} onValueChange={(value) => setExpiry(value as typeof expiry)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {EXPIRY_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </FormField>
                {scope === "full" ? (
                  <div className="flex items-start gap-2 rounded-lg bg-[var(--fx-warn-soft)] p-3 text-sm text-[var(--fx-warn-text)]">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>完全令牌能启停、新建规则，交给 AI 助手前想清楚它会做什么。</span>
                  </div>
                ) : null}
              </div>
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
                <Button onClick={handleCreate} disabled={createMutation.isPending}>{createMutation.isPending ? "创建中…" : "创建"}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
