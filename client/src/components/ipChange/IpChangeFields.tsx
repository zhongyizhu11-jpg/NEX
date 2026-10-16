import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

/** 和 server/ipChange/providers/types.ts 的 IpChangeFieldDef 同形：表单完全由云厂商声明的字段画出来，新厂商不用改界面。 */
export type IpChangeFieldDef = {
  key: string;
  label: string;
  type: "text" | "password" | "textarea" | "select";
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
};

export type IpChangeProviderView = {
  id: string;
  label: string;
  docsHint: string;
  credentialFields: IpChangeFieldDef[];
  targetFields: IpChangeFieldDef[];
  requiresDowntime: boolean;
};

export function missingRequiredFields(fields: IpChangeFieldDef[], values: Record<string, string>) {
  return fields.filter((field) => field.required && !String(values[field.key] ?? "").trim()).map((field) => field.label);
}

/**
 * 按字段定义画一组输入框。密钥类字段编辑时显示的是打码后的值：不动它保存，服务端认得出是「没改」。
 */
export function IpChangeFields({
  fields,
  values,
  onChange,
  secretHint,
}: {
  fields: IpChangeFieldDef[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  /** 编辑已有账号时，密钥框下面多一句「不改就保持原样」。 */
  secretHint?: boolean;
}) {
  if (fields.length === 0) return <p className="text-meta text-muted-foreground">这个云厂商不需要填写这一组信息。</p>;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map((field) => {
        const value = values[field.key] ?? "";
        const wide = field.type === "textarea";
        const label = `${field.label}${field.required ? " *" : ""}`;
        return (
          <FormField key={field.key} className={wide ? "space-y-1 sm:col-span-2" : "space-y-1"}>
            <Label className="text-sm">{label}</Label>
            {field.type === "select" ? (
              <Select value={value} onValueChange={(next) => onChange(field.key, next)}>
                <SelectTrigger aria-label={field.label}>
                  <SelectValue placeholder={field.placeholder || "请选择"} />
                </SelectTrigger>
                <SelectContent>
                  {(field.options || []).map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : field.type === "password" ? (
              <PasswordInput
                value={value}
                placeholder={field.placeholder}
                autoComplete="off"
                onChange={(event) => onChange(field.key, event.target.value)}
              />
            ) : field.type === "textarea" ? (
              <Textarea
                aria-label={field.label}
                value={value}
                placeholder={field.placeholder}
                rows={4}
                className="font-mono text-xs"
                onChange={(event) => onChange(field.key, event.target.value)}
              />
            ) : (
              <Input value={value} placeholder={field.placeholder} onChange={(event) => onChange(field.key, event.target.value)} />
            )}
            {field.help ? <p className="text-meta text-muted-foreground [overflow-wrap:anywhere]">{field.help}</p> : null}
            {secretHint && (field.type === "password" || field.type === "textarea") && value ? (
              <p className="text-meta text-muted-foreground">显示的是打码后的值，不改就保持原样。</p>
            ) : null}
          </FormField>
        );
      })}
    </div>
  );
}
