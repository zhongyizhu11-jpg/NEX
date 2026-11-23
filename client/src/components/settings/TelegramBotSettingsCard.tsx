/* 从 client/src/pages/Settings.tsx 抽出来的懒加载模块（见该文件里的 lazy(() => import(...))）。 */
import { FormField } from "@/components/ui/form-field";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingList, SettingRow } from "@/components/SettingRow";
import DataSectionLoading from "@/components/DataSectionLoading";
import { trpc } from "@/lib/trpc";
import { Trash2, Send, Globe, ExternalLink, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useState, useEffect } from "react";
import { useSaveDockItem } from "@/components/settings/SaveDock";
import { toast } from "sonner";

export default function TelegramBotSettingsCard() {
  const utils = trpc.useUtils();
  const { data: settings, isLoading } = trpc.system.getSettings.useQuery();
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [telegramBotTokenInput, setTelegramBotTokenInput] = useState("");
  const [telegramExpiryReminder, setTelegramExpiryReminder] = useState(false);
  const [telegramTrafficReminder, setTelegramTrafficReminder] = useState(false);
  const [telegramHostStatusNotify, setTelegramHostStatusNotify] = useState(false);
  const [telegramTrafficThreshold, setTelegramTrafficThreshold] = useState(20);
  /** 提前几天提醒。邮件、Telegram、面板顶上那条横幅共用这一个值。 */
  const [expiryReminderDays, setExpiryReminderDays] = useState("7,3,1");
  const [showDeleteTelegramBot, setShowDeleteTelegramBot] = useState(false);

  useEffect(() => {
    if (settings) {
      setTelegramEnabled(!!settings.telegram?.enabled);
      const telegramReady = !!settings.telegram?.enabled && !!settings.telegram?.configured;
      setTelegramExpiryReminder(telegramReady && !!settings.telegram?.expiryReminder);
      setTelegramTrafficReminder(telegramReady && !!settings.telegram?.trafficReminder);
      setTelegramHostStatusNotify(telegramReady && !!settings.telegram?.hostStatusNotify);
      setTelegramTrafficThreshold(Number(settings.telegram?.trafficReminderThreshold || 20));
      setExpiryReminderDays(String(settings.telegram?.expiryReminderDays || "7,3,1"));
    }
  }, [settings]);

  const updateSettingsMutation = trpc.system.updateSettings.useMutation({
    onSuccess: () => {
      utils.system.getSettings.invalidate();
      utils.system.forwardProtocols.invalidate();
      toast.success("Telegram 机器人配置已保存");
    },
    onError: (err) => toast.error(err.message || "保存失败"),
  });
  const testTelegramMutation = trpc.telegram.testSend.useMutation({
    onSuccess: () => toast.success("测试消息已发送，请查看已绑定的 Telegram"),
    onError: (err) => toast.error(err.message || "测试发送失败"),
  });

  const handleSaveTelegram = (): Promise<boolean> | boolean => {
    const canSubmitToken = !settings?.telegram?.configured && settings?.telegram?.tokenSource !== "env";
    const nextToken = canSubmitToken ? telegramBotTokenInput.trim() : "";
    const hasTelegramToken = !!settings?.telegram?.configured || settings?.telegram?.tokenSource === "env" || !!nextToken;
    const remindersReady = telegramEnabled && !!settings?.telegram?.configured;
    if (telegramEnabled && !hasTelegramToken) {
      toast.error("请先填写 Bot Token");
      return false;
    }
    if ((telegramExpiryReminder || telegramTrafficReminder || telegramHostStatusNotify) && !remindersReady) {
      toast.error("请先保存并启用 Telegram 机器人后再开启提醒");
      return false;
    }
    const saving = updateSettingsMutation.mutateAsync({
      telegram: {
        enabled: telegramEnabled,
        botToken: nextToken || undefined,
        expiryReminder: remindersReady ? telegramExpiryReminder : false,
        trafficReminder: remindersReady ? telegramTrafficReminder : false,
        hostStatusNotify: remindersReady ? telegramHostStatusNotify : false,
        trafficReminderThreshold: telegramTrafficThreshold,
        expiryReminderDays,
      },
    }).then(() => true, () => false);
    setTelegramBotTokenInput("");
    return saving;
  };

  /* 玫瑰主题下的贴底保存栏（SaveDock.tsx）：机器人这一张登记自己 */
  const telegramSaved = settings ? (() => {
    const ready = !!settings.telegram?.enabled && !!settings.telegram?.configured;
    return [
      !!settings.telegram?.enabled,
      ready && !!settings.telegram?.expiryReminder,
      ready && !!settings.telegram?.trafficReminder,
      ready && !!settings.telegram?.hostStatusNotify,
      Number(settings.telegram?.trafficReminderThreshold || 20),
      String(settings.telegram?.expiryReminderDays || "7,3,1"),
      "",
    ];
  })() : null;
  const telegramDraft = [telegramEnabled, telegramExpiryReminder, telegramTrafficReminder, telegramHostStatusNotify, Number(telegramTrafficThreshold), expiryReminderDays, telegramBotTokenInput.trim()];
  useSaveDockItem({
    id: "telegram.bot",
    label: "Telegram 机器人",
    dirty: !!telegramSaved && JSON.stringify(telegramDraft) !== JSON.stringify(telegramSaved),
    pending: updateSettingsMutation.isPending,
    save: handleSaveTelegram,
    reset: () => {
      if (!settings) return;
      const ready = !!settings.telegram?.enabled && !!settings.telegram?.configured;
      setTelegramEnabled(!!settings.telegram?.enabled);
      setTelegramExpiryReminder(ready && !!settings.telegram?.expiryReminder);
      setTelegramTrafficReminder(ready && !!settings.telegram?.trafficReminder);
      setTelegramHostStatusNotify(ready && !!settings.telegram?.hostStatusNotify);
      setTelegramTrafficThreshold(Number(settings.telegram?.trafficReminderThreshold || 20));
      setExpiryReminderDays(String(settings.telegram?.expiryReminderDays || "7,3,1"));
      setTelegramBotTokenInput("");
    },
  });

  const handleClearTelegramToken = () => {
    updateSettingsMutation.mutate({
      telegram: {
        enabled: false,
        clearToken: true,
      },
    });
    setTelegramEnabled(false);
    setTelegramBotTokenInput("");
    setShowDeleteTelegramBot(false);
  };

  const tokenSourceLabel =
    settings?.telegram?.tokenSource === "env"
      ? "环境变量 TELEGRAM_BOT_TOKEN"
      : settings?.telegram?.tokenSource === "database"
        ? "数据库配置"
        : "未配置";

  const telegramTokenLocked = !!settings?.telegram?.configured || settings?.telegram?.tokenSource === "env";
  const telegramTokenDisplayValue = telegramTokenLocked
    ? settings?.telegram?.tokenMasked || ""
    : telegramBotTokenInput;
  const hasTelegramTokenForEnable = !!settings?.telegram?.configured || settings?.telegram?.tokenSource === "env" || !!telegramBotTokenInput.trim();
  const telegramRemindersReady = telegramEnabled && !!settings?.telegram?.configured;
  const telegramReminderHint = telegramRemindersReady ? null : "请先保存并启用 Telegram 机器人。";

  return (
    <>
    <Card className="border-primary/20 bg-primary/5 backdrop-blur-md">
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Send className="h-4 w-4 text-primary" />
              Telegram 机器人
            </CardTitle>
            <CardDescription className="mt-1">
              配置 Bot Token，启用绑定、提醒和快捷登录。
            </CardDescription>
          </div>
          <Badge variant={settings?.telegram?.configured ? "default" : "outline"} className="w-fit">
            {settings?.telegram?.configured ? "已配置" : "未配置"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <DataSectionLoading label="正在加载 Telegram 配置" minHeight="min-h-[120px]" />
        ) : (
          <>
            <FormField className="space-y-2">
              <Label>Bot Token</Label>
              <Input
                type="text"
                placeholder={settings?.telegram?.tokenMasked || "从 @BotFather 获取，例如 123456:ABC..."}
                value={telegramTokenDisplayValue}
                onChange={(e) => {
                  if (!telegramTokenLocked) setTelegramBotTokenInput(e.target.value);
                }}
                readOnly={telegramTokenLocked}
                disabled={settings?.telegram?.tokenSource === "env"}
                onMouseDown={(e) => {
                  if (telegramTokenLocked) e.preventDefault();
                }}
                onSelect={(e) => {
                  if (telegramTokenLocked) e.currentTarget.setSelectionRange(0, 0);
                }}
                className={telegramTokenLocked ? "select-none font-mono" : "font-mono"}
              />
              <p className="text-xs text-muted-foreground">
                来源：{tokenSourceLabel}
              </p>
            </FormField>
            {/*
              开关和提醒原来各是一个描边小框，四个框排成两行半，第三行只有一个，右边空着。
              它们是一张清单：「机器人开不开、三种提醒各开不开」，写成一组行，提醒自己的
              参数（提前几天、阈值多少）跟在那一行下面。
            */}
            <SettingList>
              <SettingRow keepDescription
                asLabel
                label="启用机器人"
                description={settings?.telegram?.botUsername ? `@${settings.telegram.botUsername}` : "保存 Token 后自动识别机器人"}
                control={(
                  <Checkbox aria-label="启用机器人"
                    checked={telegramEnabled}
                    onCheckedChange={(checked) => {
                      if (checked && !hasTelegramTokenForEnable) {
                        toast.error("请先填写 Bot Token");
                        return;
                      }
                      setTelegramEnabled(checked);
                    }}
                  />
                )}
              />
              <SettingRow
                asLabel
                label="到期提醒"
                description={telegramReminderHint || `到期前第 ${expiryReminderDays} 天各提醒一次。`}
                control={(
                  <Checkbox aria-label="到期提醒"
                    checked={telegramRemindersReady && telegramExpiryReminder}
                    disabled={!telegramRemindersReady}
                    onCheckedChange={setTelegramExpiryReminder}
                  />
                )}
              >
                <div className="space-y-1.5">
                  <FormField className="flex max-w-xs items-center gap-2">
                    <Label className="shrink-0 text-xs text-muted-foreground">提前天数</Label>
                    <Input
                      className="h-8"
                      value={expiryReminderDays}
                      onChange={(event) => setExpiryReminderDays(event.target.value)}
                      placeholder="7,3,1"
                    />
                  </FormField>
                  {/* 说清这个值管着三处，免得有人以为它只影响 Telegram。 */}
                  <p className="text-xs text-muted-foreground">
                    逗号分隔，在这几天各发一次。邮件提醒和面板顶上的到期横幅共用这个值；填 0 表示当天也发。
                  </p>
                </div>
              </SettingRow>
              <SettingRow
                asLabel
                label="主机上线/离线通知"
                description={telegramReminderHint || "仅发送给已绑定 Telegram 的管理员。"}
                control={(
                  <Checkbox aria-label="主机上线/离线通知"
                    checked={telegramRemindersReady && telegramHostStatusNotify}
                    disabled={!telegramRemindersReady}
                    onCheckedChange={setTelegramHostStatusNotify}
                  />
                )}
              />
              <SettingRow
                asLabel
                label="流量提醒"
                description={telegramReminderHint || "低于阈值时提醒。"}
                control={(
                  <Checkbox aria-label="流量提醒"
                    checked={telegramRemindersReady && telegramTrafficReminder}
                    disabled={!telegramRemindersReady}
                    onCheckedChange={setTelegramTrafficReminder}
                  />
                )}
              >
                <FormField className="flex items-center gap-2">
                  <Label className="shrink-0 text-xs text-muted-foreground">阈值</Label>
                  <Input
                    type="number"
                    min={1}
                    max={99}
                    value={telegramTrafficThreshold}
                    onChange={(e) => setTelegramTrafficThreshold(Math.min(99, Math.max(1, Number(e.target.value) || 20)))}
                    className="h-8 w-24"
                  />
                  <span className="text-xs text-muted-foreground">%</span>
                </FormField>
              </SettingRow>
            </SettingList>
            <Alert>
              <Globe className="h-4 w-4" />
              <AlertTitle>快捷登录需要域名</AlertTitle>
              <AlertDescription>
                在系统配置填写公开地址，并在 @BotFather 绑定同一域名。
              </AlertDescription>
            </Alert>
            <div className="flex flex-wrap gap-2">
              <Button data-dock-save onClick={handleSaveTelegram} disabled={updateSettingsMutation.isPending}>
                保存 Telegram 配置
              </Button>
              <Button
                variant="outline"
                onClick={() => testTelegramMutation.mutate()}
                disabled={
                  testTelegramMutation.isPending ||
                  !settings?.telegram?.configured ||
                  !settings?.telegram?.enabled
                }
              >
                测试发送
              </Button>
              {settings?.telegram?.tokenSource === "database" && (
                <Button
                  variant="outline"
                  className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setShowDeleteTelegramBot(true)}
                  disabled={updateSettingsMutation.isPending}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  删除机器人
                </Button>
              )}
              {settings?.telegram?.botUsername && (
                <Button variant="ghost" asChild className="gap-2">
                  <a href={`https://t.me/${settings.telegram.botUsername}`} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4" />
                    打开机器人
                  </a>
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>

    <Dialog open={showDeleteTelegramBot} onOpenChange={setShowDeleteTelegramBot}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            删除 Telegram 机器人
          </DialogTitle>
          <DialogDescription>
            删除当前 Bot Token。
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm">
          <p className="text-xs text-muted-foreground">当前机器人</p>
          <p className="mt-1 font-medium">{settings?.telegram?.botUsername ? `@${settings.telegram.botUsername}` : "Telegram 机器人"}</p>
          <p className="mt-2 font-mono text-xs text-muted-foreground">{settings?.telegram?.tokenMasked || "-"}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowDeleteTelegramBot(false)}>
            取消
          </Button>
          <Button variant="destructive" onClick={handleClearTelegramToken} disabled={updateSettingsMutation.isPending}>
            确认删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
