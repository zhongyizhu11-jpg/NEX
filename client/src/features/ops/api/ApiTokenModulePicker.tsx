import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { API_TOKEN_MODULES, API_TOKEN_MODULE_DETAILS, API_TOKEN_MODULE_LABELS, type ApiTokenModule } from "@shared/apiTokenModules";

/**
 * 令牌能碰哪几块：一格一个模块，勾了就只给这些；一个都不勾 = 全部模块（和老令牌一样）。
 * 手机上一列，宽一点两列；每格写清楚管什么，免得「系统设置」到底含不含插件要去猜。
 */
export function ApiTokenModulePicker({ value, onChange, disabled }: {
  value: ApiTokenModule[];
  onChange: (next: ApiTokenModule[]) => void;
  disabled?: boolean;
}) {
  const toggle = (module: ApiTokenModule, checked: boolean) => {
    const set = new Set(value);
    if (checked) set.add(module);
    else set.delete(module);
    onChange(API_TOKEN_MODULES.filter((item) => set.has(item)));
  };
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="令牌能访问的模块">
        {API_TOKEN_MODULES.map((module) => {
          const checked = value.includes(module);
          return (
            <label
              key={module}
              className={cn(
                "flex min-w-0 cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors",
                checked ? "border-primary/60 bg-primary/5" : "border-[var(--fx-stroke-weak)] hover:bg-[var(--fx-hover)]",
                disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <Checkbox
                className="mt-0.5"
                checked={checked}
                disabled={disabled}
                aria-label={API_TOKEN_MODULE_LABELS[module]}
                onCheckedChange={(next) => toggle(module, next)}
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-medium text-foreground">{API_TOKEN_MODULE_LABELS[module]}</span>
                <span className="text-meta text-muted-foreground">{API_TOKEN_MODULE_DETAILS[module]}</span>
              </span>
            </label>
          );
        })}
      </div>
      <p className="text-meta text-muted-foreground">
        {value.length === 0 ? "一个都不勾 = 全部模块都能访问。" : `只能访问勾上的 ${value.length} 个模块，其余一律拒绝。`}
      </p>
    </div>
  );
}
