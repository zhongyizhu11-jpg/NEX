/**
 * 用户编辑弹窗里的「订阅」一小段：这个人的自定义分流规则和指定模板。
 * 自带读取和保存，不混进用户弹窗那张大表单 —— 那张表单的保存走的是流量设置接口。
 */

import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export default function UserProxySubConfig({ userId }: { userId: number | null }) {
  const configQuery = trpc.proxySubscriptions.adminGetUserConfig.useQuery({ userId: userId || 0 }, { enabled: !!userId });
  const templatesQuery = trpc.proxySubscriptions.adminListTemplates.useQuery(undefined, { enabled: !!userId });
  const validateQuery = trpc.proxySubscriptions.validateCustomRules.useQuery;
  const [customRules, setCustomRules] = useState("");
  const [templateId, setTemplateId] = useState("0");
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (configQuery.data) {
      setCustomRules(configQuery.data.customRules);
      setTemplateId(String(configQuery.data.templateId || 0));
      setDirty(false);
    }
  }, [configQuery.data]);
  const validation = validateQuery({ text: customRules }, { enabled: !!userId && customRules.trim().length > 0 });
  const save = trpc.proxySubscriptions.adminSetUserConfig.useMutation({
    onSuccess: () => {
      toast.success("订阅配置已保存");
      setDirty(false);
      void configQuery.refetch();
    },
    onError: (error) => toast.error(error.message || "保存失败"),
  });
  if (!userId) return null;
  return (
    <div className="space-y-3 rounded-lg border border-border/60 p-3">
      <div>
        <Label className="text-sm font-medium">订阅</Label>
        <p data-fx-help="" className="mt-1 text-xs text-muted-foreground">
          这个人的规则订阅用哪份模板，以及只给他加的分流规则（排在预设规则前）。这一段单独保存。
        </p>
      </div>
      <FormField className="space-y-1.5">
        <Label>订阅模板</Label>
        <Select value={templateId} onValueChange={(value) => { setTemplateId(value); setDirty(true); }}>
          <SelectTrigger aria-label="订阅模板"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="0">不指定（套餐 → 默认）</SelectItem>
            {(templatesQuery.data?.templates || []).map((template) => (
              <SelectItem key={template.id} value={String(template.id)}>{template.name}（{template.target}）</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <FormField className="space-y-1.5">
        <Label>自定义分流规则</Label>
        <Textarea
          value={customRules}
          onChange={(event) => { setCustomRules(event.target.value); setDirty(true); }}
          rows={4}
          className="font-mono text-xs"
          placeholder={"DOMAIN-SUFFIX,example.com,DIRECT\nGEOIP,JP,PROXY"}
        />
        {validation.data && validation.data.errors.length > 0 ? (
          <p className="text-xs text-[var(--fx-down-text)]">第 {validation.data.errors[0].line} 行：{validation.data.errors[0].message}</p>
        ) : null}
      </FormField>
      <div className="flex justify-end">
        <Button size="sm" variant="outline" disabled={!dirty || save.isPending} onClick={() => save.mutate({ userId, customRules, templateId: Math.max(0, Number(templateId) || 0) })}>
          保存订阅配置
        </Button>
      </div>
    </div>
  );
}
