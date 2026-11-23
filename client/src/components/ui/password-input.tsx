import { Input } from "@/components/ui/input";
import { Eye, EyeOff } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * 带「显示 / 隐藏」的密码框。
 *
 * 手册把这条列为硬性要求：**密码框必须有「显示 / 隐藏」**。原来全站 32 个密码框
 * 里只有登录页那两个有，其余 30 个只能盲打 —— 填 API Token、商户密钥、SMTP 密码
 * 这类又长又杂的串时，看不见就只能靠重填一遍来确认。
 *
 * 做成一个组件而不是在 30 个地方各摆一个眼睛图标：图标、位置、文案、
 * 无障碍名称只有一份，不会你改我不改。
 *
 * 和登录页那版的两点不同：
 *   - 切换按钮**可以用键盘聚焦**（登录页写的是 `tabIndex={-1}`）。
 *     只能用鼠标点的「显示密码」，对键盘用户等于没有。
 *   - 按钮有 `aria-label` 和 `aria-pressed`，读屏能念出当前是显示还是隐藏。
 *
 * id 仍然由 `FormField` 的 context 发给里面的 `Input`，多套一层 div 不影响。
 */
type PasswordInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">;

const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(({ className, ...props }, ref) => {
  const [revealed, setRevealed] = React.useState(false);
  return (
    <div className="relative">
      <Input
        {...props}
        ref={ref}
        type={revealed ? "text" : "password"}
        className={cn("pr-10", className)}
      />
      <button
        type="button"
        onClick={() => setRevealed((current) => !current)}
        aria-label={revealed ? "隐藏密码" : "显示密码"}
        aria-pressed={revealed}
        className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
});
PasswordInput.displayName = "PasswordInput";

export { PasswordInput };
