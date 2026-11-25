/* 从 client/src/pages/Settings.tsx 抽出来的懒加载模块（见该文件里的 lazy(() => import(...))）。 */
import { FormField } from "@/components/ui/form-field";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SettingList, SettingRow } from "@/components/SettingRow";
import DataSectionLoading from "@/components/DataSectionLoading";
import { trpc } from "@/lib/trpc";
import { Trash2, Key, Loader2 } from "lucide-react";
import { useMemo, useState, useEffect } from "react";
import { toast } from "sonner";

type AiProvider = "deepseek" | "siliconflow" | "custom";

const aiProviderOptions: Array<{ value: AiProvider; label: string }> = [
  { value: "deepseek", label: "DeepSeek" },
  { value: "siliconflow", label: "SiliconFlow（聚合平台）" },
  { value: "custom", label: "自定义 OpenAI 兼容" },
];

const aiProviderDefaults: Record<AiProvider, { baseUrl: string; model: string }> = {
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
  },
  siliconflow: {
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-R1-0528-Qwen3-8B",
  },
  custom: {
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
  },
};

type AiProviderServerConfig = {
  provider?: AiProvider;
  configured?: boolean;
  apiKeyMasked?: string;
  baseUrl?: string;
  model?: string;
};

type AiProviderLocalConfig = {
  configured: boolean;
  apiKeyMasked: string;
  apiKeyInput: string;
  baseUrl: string;
  model: string;
};

type AiProviderLocalConfigMap = Record<AiProvider, AiProviderLocalConfig>;


function createDefaultAiProviderConfig(provider: AiProvider): AiProviderLocalConfig {
  return {
    configured: false,
    apiKeyMasked: "",
    apiKeyInput: "",
    baseUrl: aiProviderDefaults[provider].baseUrl,
    model: aiProviderDefaults[provider].model,
  };
}


function createDefaultAiProviderConfigMap(): AiProviderLocalConfigMap {
  return {
    deepseek: createDefaultAiProviderConfig("deepseek"),
    siliconflow: createDefaultAiProviderConfig("siliconflow"),
    custom: createDefaultAiProviderConfig("custom"),
  };
}


function normalizeAiProviderValue(value: unknown): AiProvider {
  const raw = String(value || "").trim();
  return aiProviderOptions.some((item) => item.value === raw)
    ? (raw as AiProvider)
    : "deepseek";
}


function toLocalAiProviderConfig(provider: AiProvider, source?: AiProviderServerConfig): AiProviderLocalConfig {
  return {
    configured: !!source?.configured,
    apiKeyMasked: String(source?.apiKeyMasked || ""),
    apiKeyInput: "",
    baseUrl: String(source?.baseUrl || "").trim() || aiProviderDefaults[provider].baseUrl,
    model: String(source?.model || "").trim() || aiProviderDefaults[provider].model,
  };
}


export default function DeepSeekSettingsCard() {
  const utils = trpc.useUtils();
  const { data: settings, isLoading } = trpc.system.getSettings.useQuery();
  const [deepseekProvider, setDeepseekProvider] = useState<AiProvider>("deepseek");
  const [deepseekEnabled, setDeepseekEnabled] = useState(false);
  const [providerConfigs, setProviderConfigs] = useState<AiProviderLocalConfigMap>(() => createDefaultAiProviderConfigMap());
  const [deepseekMaxTokens, setDeepseekMaxTokens] = useState(1024);
  const [deepseekTemperature, setDeepseekTemperature] = useState(0.2);
  const [deepseekTelegramUserManageEnabled, setDeepseekTelegramUserManageEnabled] = useState(true);
  const [deepseekTelegramAutoRecallEnabled, setDeepseekTelegramAutoRecallEnabled] = useState(false);
  const [deepseekTelegramAutoRecallSeconds, setDeepseekTelegramAutoRecallSeconds] = useState(60);
  const confirmDialog = useConfirmDialog();
  const activeProviderConfig = providerConfigs[deepseekProvider] || createDefaultAiProviderConfig(deepseekProvider);
  const deepseekBaseUrl = activeProviderConfig.baseUrl;
  const deepseekModel = activeProviderConfig.model;
  const providerConfigured = !!activeProviderConfig.configured;
  const aiModelsQuery = trpc.system.listAiModels.useQuery(
    {
      provider: deepseekProvider,
      baseUrl: deepseekBaseUrl.trim() || undefined,
      chatOnly: true,
    },
    {
      enabled: providerConfigured,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  );

  useEffect(() => {
    if (settings?.deepseek) {
      const provider = normalizeAiProviderValue(settings.deepseek.provider);
      const serverProviders = (settings.deepseek as any).providers || {};
      const activeServerConfig = settings.deepseek as AiProviderServerConfig;
      const deepseekServerConfig = (serverProviders.deepseek as AiProviderServerConfig | undefined)
        || (provider === "deepseek" ? activeServerConfig : undefined);
      const siliconflowServerConfig = (serverProviders.siliconflow as AiProviderServerConfig | undefined)
        || (provider === "siliconflow" ? activeServerConfig : undefined);
      const customServerConfig = (serverProviders.custom as AiProviderServerConfig | undefined)
        || (provider === "custom" ? activeServerConfig : undefined);
      setProviderConfigs({
        deepseek: toLocalAiProviderConfig("deepseek", deepseekServerConfig),
        siliconflow: toLocalAiProviderConfig("siliconflow", siliconflowServerConfig),
        custom: toLocalAiProviderConfig("custom", customServerConfig),
      });
      setDeepseekProvider(provider);
      setDeepseekEnabled(!!settings.deepseek.enabled);
      setDeepseekMaxTokens(Number(settings.deepseek.maxTokens || 1024));
      setDeepseekTemperature(Number(settings.deepseek.temperature ?? 0.2));
      setDeepseekTelegramUserManageEnabled(settings.deepseek.telegramUserManageEnabled !== false);
      setDeepseekTelegramAutoRecallEnabled(!!settings.deepseek.telegramAutoRecallEnabled);
      setDeepseekTelegramAutoRecallSeconds(Math.min(1200, Math.max(30, Number(settings.deepseek.telegramAutoRecallSeconds || 60))));
    }
  }, [settings]);

  const updateSettingsMutation = trpc.system.updateSettings.useMutation({
    onSuccess: (_data, variables) => {
      utils.system.getSettings.invalidate();
      utils.system.forwardProtocols.invalidate();
      utils.system.listAiModels.invalidate();
      setProviderConfigs((prev) => ({
        deepseek: { ...prev.deepseek, apiKeyInput: "" },
        siliconflow: { ...prev.siliconflow, apiKeyInput: "" },
        custom: { ...prev.custom, apiKeyInput: "" },
      }));
      if (variables.deepseek?.clearApiKey) {
        const clearedProvider = normalizeAiProviderValue(variables.deepseek.provider);
        setDeepseekEnabled(false);
        setProviderConfigs((prev) => ({
          ...prev,
          [clearedProvider]: {
            ...(prev[clearedProvider] || createDefaultAiProviderConfig(clearedProvider)),
            configured: false,
            apiKeyMasked: "",
            apiKeyInput: "",
          },
        }));
        toast.success("AI API Key 已删除");
        return;
      }
      toast.success("AI 配置已保存");
    },
    onError: (err) => toast.error(err.message || "保存失败"),
  });

  const selectedModelMeta = useMemo(() => {
    const models = Array.isArray(aiModelsQuery.data?.models) ? aiModelsQuery.data.models : [];
    return models.find((item: any) => String(item?.id || "") === deepseekModel.trim()) || null;
  }, [aiModelsQuery.data?.models, deepseekModel]);

  const updateProviderConfig = (provider: AiProvider, patch: Partial<AiProviderLocalConfig>) => {
    setProviderConfigs((prev) => ({
      ...prev,
      [provider]: {
        ...(prev[provider] || createDefaultAiProviderConfig(provider)),
        ...patch,
      },
    }));
  };

  const updateActiveProviderConfig = (patch: Partial<AiProviderLocalConfig>) => {
    updateProviderConfig(deepseekProvider, patch);
  };

  const handleProviderChange = (value: string) => {
    const provider = normalizeAiProviderValue(value);
    setDeepseekProvider(provider);
  };

  const normalizeMaxTokens = () => {
    const value = Math.floor(Number(deepseekMaxTokens));
    if (!Number.isFinite(value)) return 1024;
    return Math.min(8192, Math.max(128, value));
  };

  const normalizeTemperature = () => {
    const value = Number(deepseekTemperature);
    if (!Number.isFinite(value)) return 0.2;
    return Math.min(2, Math.max(0, value));
  };

  const normalizeTelegramAutoRecallSeconds = () => {
    const value = Math.floor(Number(deepseekTelegramAutoRecallSeconds));
    if (!Number.isFinite(value)) return 60;
    return Math.min(1200, Math.max(30, value));
  };

  const handleSaveDeepSeek = () => {
    const nextApiKey = activeProviderConfig.apiKeyInput.trim();
    const hasApiKey = providerConfigured || !!nextApiKey;
    if (deepseekEnabled && !hasApiKey) {
      toast.error("请先填写 AI API Key");
      return;
    }
    const maxTokens = normalizeMaxTokens();
    const temperature = normalizeTemperature();
    const telegramAutoRecallSeconds = normalizeTelegramAutoRecallSeconds();
    updateSettingsMutation.mutate({
      deepseek: {
        provider: deepseekProvider,
        enabled: deepseekEnabled,
        apiKey: !providerConfigured && nextApiKey ? nextApiKey : undefined,
        baseUrl: deepseekBaseUrl.trim() || aiProviderDefaults[deepseekProvider].baseUrl,
        model: deepseekModel.trim() || aiProviderDefaults[deepseekProvider].model,
        maxTokens,
        temperature,
        telegramUserManageEnabled: deepseekTelegramUserManageEnabled,
        telegramAutoRecallEnabled: deepseekTelegramAutoRecallEnabled,
        telegramAutoRecallSeconds,
      },
    });
    setDeepseekMaxTokens(maxTokens);
    setDeepseekTemperature(temperature);
    setDeepseekTelegramAutoRecallSeconds(telegramAutoRecallSeconds);
  };

  // 删 Key 走共享的确认框：请求在路上时弹窗留着、按钮写「正在删除...」，成功了才关；当前配置那三行放 details 槽
  const confirmClearDeepSeekKey = () => {
    void confirmDialog({
      title: "删除 AI API Key",
      description: "删除后会同时关闭 AI 助手，需要重新填写 API Key 后才能启用。",
      details: (
        <div className="rounded-lg border border-border/40 bg-muted/20 p-3 text-sm">
          <p className="text-xs text-muted-foreground">当前配置</p>
          <p className="mt-1 truncate font-medium">{providerLabel}</p>
          <p className="mt-1 truncate font-medium">{deepseekModel || activeProviderDefaults.model}</p>
          <p
            className="mt-2 truncate font-mono text-xs text-muted-foreground"
            title={activeProviderConfig.apiKeyMasked || undefined}
          >
            {activeProviderConfig.apiKeyMasked || "-"}
          </p>
        </div>
      ),
      confirmText: "确认删除",
      confirmPendingText: "正在删除...",
      onConfirm: () => updateSettingsMutation.mutateAsync({
        deepseek: {
          provider: deepseekProvider,
          enabled: false,
          clearApiKey: true,
        },
      }),
    });
  };

  const deepseekKeyLocked = providerConfigured;
  const deepseekKeyDisplayValue = deepseekKeyLocked
    ? activeProviderConfig.apiKeyMasked || ""
    : activeProviderConfig.apiKeyInput;
  const hasDeepSeekKeyForEnable = providerConfigured || !!activeProviderConfig.apiKeyInput.trim();
  const activeProviderDefaults = aiProviderDefaults[deepseekProvider];
  const providerLabel = aiProviderOptions.find((item) => item.value === deepseekProvider)?.label || deepseekProvider;
  const models = Array.isArray(aiModelsQuery.data?.models) ? aiModelsQuery.data.models : [];
  const knownFreeCount = Number(aiModelsQuery.data?.freeCount || 0);
  const knownPaidCount = Number(aiModelsQuery.data?.paidCount || 0);
  const unknownFreeCount = Number(aiModelsQuery.data?.unknownCount || 0);

  return (
    <>
      <Card className="border-[color-mix(in_srgb,var(--fx-healthy)_25%,transparent)] bg-[color-mix(in_srgb,var(--fx-healthy)_5%,transparent)] backdrop-blur-md">
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Key className="h-4 w-4 text-[var(--fx-healthy-text)]" />
                AI 助手模型
              </CardTitle>
              <CardDescription className="mt-1">
                支持 DeepSeek / SiliconFlow / 自定义 OpenAI 兼容接口，用于 Telegram AI 指令解析。
              </CardDescription>
            </div>
            <Badge variant={providerConfigured ? "default" : "outline"} className="w-fit">
              {providerConfigured ? "已配置" : "未配置"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <DataSectionLoading label="正在加载 AI 配置" minHeight="min-h-[120px]" />
          ) : (
            <>
              {/*
                「启用 AI 助手」原来画成一个输入框的样子（40px 高、描边、里面一行灰字 + 复选框），
                和旁边的「提供商」选择框并排 —— 看上去像另一个要填的字段。它是一个开关，
                放到最上面一行：先说开不开，再说用谁。
              */}
              <SettingList>
                <SettingRow
                  asLabel
                  label="启用 AI 助手"
                  description={providerConfigured
                    ? `${providerLabel} · ${deepseekModel}${selectedModelMeta?.isFree === true ? " · Free" : (selectedModelMeta?.isFree === false ? " · Paid" : "")}`
                    : "保存 API Key 后启用"}
                  control={(
                    <Checkbox aria-label="启用 AI 助手"
                      checked={deepseekEnabled}
                      onCheckedChange={(checked) => {
                        if (checked && !hasDeepSeekKeyForEnable) {
                          toast.error("请先填写 AI API Key");
                          return;
                        }
                        setDeepseekEnabled(checked);
                      }}
                    />
                  )}
                />
              </SettingList>
              <div className="grid gap-3 md:grid-cols-2">
                <FormField className="space-y-2">
                  <Label>提供商</Label>
                  <Select value={deepseekProvider} onValueChange={handleProviderChange}>
                    <SelectTrigger className="h-10">
                      <SelectValue placeholder="选择提供商" />
                    </SelectTrigger>
                    <SelectContent>
                      {aiProviderOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
              </div>

              <div className="grid gap-3 @[42rem]:grid-cols-12">
                <FormField className="space-y-2 @[42rem]:col-span-5">
                  <Label>API Key</Label>
                  <Input
                    type="text"
                    placeholder={activeProviderConfig.apiKeyMasked || "从提供商控制台获取，例如 sk-..."}
                    value={deepseekKeyDisplayValue}
                    onChange={(e) => {
                      if (!deepseekKeyLocked) updateActiveProviderConfig({ apiKeyInput: e.target.value });
                    }}
                    readOnly={deepseekKeyLocked}
                    onMouseDown={(e) => {
                      if (deepseekKeyLocked) e.preventDefault();
                    }}
                    onSelect={(e) => {
                      if (deepseekKeyLocked) e.currentTarget.setSelectionRange(0, 0);
                    }}
                    className={deepseekKeyLocked ? "select-none font-mono" : "font-mono"}
                  />
                  <p className="text-xs text-muted-foreground">
                    按提供商分别保存 API Key，切换提供商时会自动带出对应配置。
                  </p>
                </FormField>
                <FormField className="space-y-2 @[42rem]:col-span-3">
                  <Label>接口地址</Label>
                  <Input
                    type="text"
                    value={deepseekBaseUrl}
                    onChange={(e) => updateActiveProviderConfig({ baseUrl: e.target.value })}
                    placeholder={activeProviderDefaults.baseUrl}
                    className="font-mono"
                  />
                </FormField>
                <FormField className="space-y-2 @[42rem]:col-span-4">
                  <Label>模型</Label>
                  <Input
                    type="text"
                    value={deepseekModel}
                    onChange={(e) => updateActiveProviderConfig({ model: e.target.value })}
                    placeholder={activeProviderDefaults.model}
                    className="font-mono"
                  />
                </FormField>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">可用聊天模型（支持展示 Free 状态）</p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => aiModelsQuery.refetch()}
                    disabled={!providerConfigured || aiModelsQuery.isFetching}
                  >
                    {aiModelsQuery.isFetching && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                    刷新
                  </Button>
                </div>
                {!!providerConfigured && models.length > 0 && (
                  <Select
                    value={models.some((item: any) => String(item?.id || "") === deepseekModel) ? deepseekModel : undefined}
                    onValueChange={(value) => updateActiveProviderConfig({ model: value })}
                  >
                    <SelectTrigger aria-label="从列表选择模型" className="h-9">
                      <SelectValue placeholder="从列表选择模型" />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      {models.map((item: any) => (
                        <SelectItem key={String(item?.id || "")} value={String(item?.id || "")}>
                          {String(item?.id || "")}
                          {item?.isFree === true ? " · 🆓free" : (item?.isFree === false ? " · 💳paid" : "")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {!!providerConfigured && models.length > 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    共 {models.length} 个，Free {knownFreeCount} 个，付费 {knownPaidCount} 个，未知 {unknownFreeCount} 个。
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {providerConfigured
                      ? (aiModelsQuery.data?.error || "暂未获取到模型列表，可手动输入模型名称。")
                      : "保存 API Key 后可拉取模型列表。"}
                  </p>
                )}
              </div>

              <div className="grid gap-3 sm:max-w-[560px] sm:grid-cols-2">
                <FormField className="space-y-2">
                  <Label>最大输出</Label>
                  <Input
                    type="number"
                    min={128}
                    max={8192}
                    value={deepseekMaxTokens}
                    onChange={(e) => setDeepseekMaxTokens(Math.min(8192, Math.max(128, Number(e.target.value) || 1024)))}
                  />
                </FormField>
                <FormField className="space-y-2">
                  <Label>温度</Label>
                  <Input
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={deepseekTemperature}
                    onChange={(e) => setDeepseekTemperature(Math.min(2, Math.max(0, Number(e.target.value) || 0)))}
                  />
                </FormField>
              </div>

              <SettingList>
                <SettingRow
                  asLabel
                  label="普通用户可用 AI 管理"
                  description="关闭后普通用户不能使用 AI 对话执行管理操作。"
                  control={(
                    <Checkbox aria-label="普通用户可用 AI 管理"
                      checked={deepseekTelegramUserManageEnabled}
                      onCheckedChange={setDeepseekTelegramUserManageEnabled}
                    />
                  )}
                />
                {/* 撤回时间是「自动撤回」的参数，原来单独占一个框，和它隔着一格。 */}
                <SettingRow
                  asLabel
                  label="机器人信息自动撤回"
                  description="仅对 AI 相关聊天内容生效，默认关闭。"
                  control={(
                    <Checkbox aria-label="机器人信息自动撤回"
                      checked={deepseekTelegramAutoRecallEnabled}
                      onCheckedChange={setDeepseekTelegramAutoRecallEnabled}
                    />
                  )}
                >
                  <FormField className="flex flex-wrap items-center gap-2">
                    <Label className="shrink-0 text-xs text-muted-foreground">撤回时间</Label>
                    <Input
                      type="number"
                      min={30}
                      max={1200}
                      value={deepseekTelegramAutoRecallSeconds}
                      onChange={(e) => setDeepseekTelegramAutoRecallSeconds(Math.min(1200, Math.max(30, Number(e.target.value) || 60)))}
                      className="h-8 w-24"
                    />
                    <span className="text-xs text-muted-foreground">秒（30–1200，默认 60）</span>
                  </FormField>
                </SettingRow>
              </SettingList>

              <div className="flex flex-wrap gap-2">
                <Button onClick={handleSaveDeepSeek} disabled={updateSettingsMutation.isPending}>
                  {updateSettingsMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  保存 AI 配置
                </Button>
                {providerConfigured && (
                  <Button
                    variant="outline"
                    className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={confirmClearDeepSeekKey}
                    disabled={updateSettingsMutation.isPending}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    删除 API Key
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

    </>
  );
}
