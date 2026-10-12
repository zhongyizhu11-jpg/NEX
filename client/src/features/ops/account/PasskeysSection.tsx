import { useState } from "react";
import { KeyRound, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormField } from "@/components/ui/form-field";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { SettingList, SettingRow } from "@/components/SettingRow";
import DataSectionLoading from "@/components/DataSectionLoading";
import DataSectionError from "@/components/DataSectionError";
import { trpc } from "@/lib/trpc";
import { createPasskeyCredential, PASSKEY_INSECURE_MESSAGE, passkeyAvailability, passkeyErrorMessage } from "./webauthnClient";
import { dateLabel, relativeTimeLabel } from "./timeLabel";

/**
 * 个人资料 › 通行密钥（#12）。
 *
 * 添加之后，登录页点「用通行密钥登录」，按一下指纹 / 面容就进来了，不用输密码，也不用 2FA。
 * App 里不显示（系统通行密钥绑在面板域名上，App 的 WebView 用不了）；http 访问时说明原因、不给按钮。
 */
export default function PasskeysSection(_props: Record<string, never>) {
  const availability = passkeyAvailability();
  const utils = trpc.useUtils();
  const confirm = useConfirmDialog();
  const listQuery = trpc.ops.passkeys.list.useQuery(undefined, { enabled: availability.usable || availability.reason !== "native" });
  const optionsMutation = trpc.ops.passkeys.registrationOptions.useMutation();
  const finishMutation = trpc.ops.passkeys.finishRegistration.useMutation();
  const renameMutation = trpc.ops.passkeys.rename.useMutation();
  const removeMutation = trpc.ops.passkeys.remove.useMutation();
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);

  if (!availability.usable && availability.reason === "native") return null;

  const items = listQuery.data ?? [];

  const handleAdd = async () => {
    setAdding(true);
    try {
      const options = await optionsMutation.mutateAsync({ origin: window.location.origin });
      const credential = await createPasskeyCredential(options.publicKey);
      const created = await finishMutation.mutateAsync({ challengeId: options.challengeId, credential });
      await utils.ops.passkeys.list.invalidate();
      toast.success(`已添加通行密钥「${created.name}」`);
    } catch (error) {
      toast.error(passkeyErrorMessage(error, "添加通行密钥失败"));
    } finally {
      setAdding(false);
    }
  };

  const handleRename = async () => {
    if (!renaming) return;
    const name = renaming.name.trim();
    if (!name) {
      toast.error("请填写名字");
      return;
    }
    try {
      await renameMutation.mutateAsync({ id: renaming.id, name });
      await utils.ops.passkeys.list.invalidate();
      setRenaming(null);
      toast.success("已改名");
    } catch (error) {
      toast.error(passkeyErrorMessage(error, "改名失败"));
    }
  };

  const handleRemove = async (item: { id: number; name: string }) => {
    const ok = await confirm({
      title: "删除通行密钥",
      description: `删除「${item.name}」后，这台设备就不能再用通行密钥登录了，密码登录不受影响。设备里存的那份密钥需要你在系统设置里自己删。`,
      confirmText: "删除",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await removeMutation.mutateAsync({ id: item.id });
      await utils.ops.passkeys.list.invalidate();
      toast.success("已删除");
    } catch (error) {
      toast.error(passkeyErrorMessage(error, "删除失败"));
    }
  };

  return (
    <Card className="border-border/50 bg-card/70">
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4 text-primary" />
            通行密钥
          </CardTitle>
          <CardDescription>用指纹、面容或设备密码登录，不用输密码，也不用再填 2FA 验证码。</CardDescription>
        </div>
        {availability.usable ? (
          <Button className="w-full gap-2 sm:w-auto" onClick={handleAdd} disabled={adding}>
            {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {adding ? "等待设备确认…" : "添加通行密钥"}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {!availability.usable ? (
          <p className="text-sm text-muted-foreground">
            {availability.reason === "insecure" ? `${PASSKEY_INSECURE_MESSAGE}，当前是 http 访问。` : "这个浏览器不支持通行密钥。"}
          </p>
        ) : null}
        {listQuery.isLoading ? (
          <DataSectionLoading label="正在加载通行密钥" minHeight="min-h-[72px]" />
        ) : listQuery.error ? (
          <DataSectionError label="通行密钥" error={listQuery.error} onRetry={() => listQuery.refetch()} retrying={listQuery.isFetching} minHeight="min-h-[96px]" />
        ) : items.length === 0 ? (
          availability.usable ? <p className="text-sm text-muted-foreground">还没有添加。在常用的手机或电脑上添加一个，下次登录就快了。</p> : null
        ) : (
          <SettingList>
            {items.map((item) => (
              <SettingRow
                key={item.id}
                label={<span className="break-all">{item.name}</span>}
                description={`添加于 ${dateLabel(item.createdAt)} · 上次使用 ${relativeTimeLabel(item.lastUsedAt)}`}
                control={(
                  <>
                    <Button variant="ghost" size="icon" className="h-9 w-9" title="改名" aria-label={`给「${item.name}」改名`} onClick={() => setRenaming({ id: item.id, name: item.name })}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-9 w-9 text-destructive hover:text-destructive" title="删除" aria-label={`删除「${item.name}」`} onClick={() => handleRemove(item)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </>
                )}
              />
            ))}
          </SettingList>
        )}
      </CardContent>

      <Dialog open={!!renaming} onOpenChange={(open) => { if (!open) setRenaming(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>给通行密钥改名</DialogTitle>
            <DialogDescription>起个能认出设备的名字，比如「工作电脑」「我的 iPhone」。</DialogDescription>
          </DialogHeader>
          <FormField className="space-y-2">
            <Label>名字</Label>
            <Input
              value={renaming?.name ?? ""}
              maxLength={64}
              onChange={(event) => setRenaming((current) => (current ? { ...current, name: event.target.value } : current))}
              onKeyDown={(event) => { if (event.key === "Enter") void handleRename(); }}
            />
          </FormField>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRenaming(null)}>取消</Button>
            <Button onClick={handleRename} disabled={renameMutation.isPending}>{renameMutation.isPending ? "保存中…" : "保存"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
