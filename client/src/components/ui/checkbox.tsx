import { useFormFieldId } from "@/components/ui/form-field";
import { Check } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * 复选框。
 *
 * 手册的分工：**Switch 用于「切换后立即生效、无需提交」，需要提交的用 Checkbox**。
 * 一个亮着的开关在用户眼里就是「已经生效了」；如果它其实要等点保存，
 * 那这个开关一直在说谎 —— 关掉对话框改动就没了，界面上看不出来。
 *
 * 实现用**原生 `<input type="checkbox">`**，不引第三方组件：
 * 键盘（空格切换）、`<label>` 关联、焦点、表单语义全都是浏览器自带的，
 * 和手册「不要用 div 模拟按钮」是同一个道理。勾用一个绝对定位的图标画，
 * 颜色走 `text-primary-foreground` 令牌，深浅色自动跟着走。
 *
 * props 刻意和 `Switch` 对齐（`checked` / `onCheckedChange`），
 * 所以现场替换就是把标签名改掉，其余一个字不动。
 */
type CheckboxProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "onChange" | "size"> & {
  onCheckedChange?: (checked: boolean) => void;
};

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, onCheckedChange, ...props }, ref) => {
    const fieldId = useFormFieldId();
    return (
      <span className="relative inline-flex shrink-0 items-center justify-center">
        <input
          type="checkbox"
          data-slot="checkbox"
          id={fieldId}
          ref={ref}
          onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
          className={cn(
            "fx-checkbox peer h-5 w-5 shrink-0 cursor-pointer appearance-none rounded-[5px] border border-[var(--fx-stroke-strong)] bg-background",
            "transition-colors hover:border-foreground focus-visible:outline-none focus-visible:shadow-[var(--fx-focus-ring)]",
            "checked:border-primary checked:bg-primary",
            "disabled:cursor-not-allowed disabled:opacity-60",
            className,
          )}
          {...props}
        />
        <Check
          aria-hidden
          className="pointer-events-none absolute h-3.5 w-3.5 text-primary-foreground opacity-0 transition-opacity peer-checked:opacity-100"
          strokeWidth={3}
        />
      </span>
    );
  },
);
Checkbox.displayName = "Checkbox";

export { Checkbox };
