import { useFormFieldId } from "@/components/ui/form-field";
import * as React from "react"
import * as SwitchPrimitives from "@radix-ui/react-switch"
import { cn } from "@/lib/utils"
import { settledToggleChecked } from "@/lib/optimisticToggle";

type SwitchProps = React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root> & {
  instant?: boolean;
  /** sm：30×18 的小开关（线路卡里一行里放好几个时用）。 */
  size?: "default" | "sm";
};

/*
  开关也接进 FormField —— 和 Input/Textarea/SelectTrigger 一样从 context 拿 id。

  Radix 的开关渲染出来是一个 <button role="switch">，而 <label for> 对 button
  一样有效（Chrome 里这条名称来源叫 labelwrapped / labelfor，实测过）。
  接上之后 `<FormField><Label>转发总开关</Label><Switch /></FormField>` 就有名字了，
  不用再把同一句话在 aria-label 里抄第二遍 —— 抄第二遍早晚会和界面对不上。
*/
const Switch = React.forwardRef<React.ComponentRef<typeof SwitchPrimitives.Root>, SwitchProps>(({ className, instant = false, size = "default", ...props }, ref) => {
  const fieldId = useFormFieldId();
  const small = size === "sm";
  return (
  <SwitchPrimitives.Root data-slot="switch" id={fieldId} className={cn("peer relative inline-flex shrink-0 cursor-pointer items-center rounded-full border-0 focus-visible:outline-none focus-visible:shadow-[var(--fx-focus-ring)] disabled:cursor-not-allowed disabled:opacity-60 data-[state=unchecked]:bg-[var(--fx-stroke-base)] data-[state=checked]:bg-primary dark:data-[state=unchecked]:bg-[var(--fx-stroke-strong)]", small ? "h-[18px] w-[30px] p-[2px]" : "h-6 w-11 p-0.5", instant ? "" : "transition-colors", className)} {...props} ref={ref}>
    <SwitchPrimitives.Thumb className={cn("pointer-events-none block rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.24),0_0_0_0.5px_rgb(0_0_0/0.06)] ring-0 data-[state=unchecked]:translate-x-0", small ? "h-[14px] w-[14px] data-[state=checked]:translate-x-3" : "h-5 w-5 data-[state=checked]:translate-x-5", instant ? "" : "transition-transform")} />
  </SwitchPrimitives.Root>
  );
})
Switch.displayName = SwitchPrimitives.Root.displayName

type OptimisticSwitchProps = Omit<SwitchProps, "checked" | "defaultChecked" | "onCheckedChange"> & {
  checked: boolean;
  onCheckedChangeAsync: (checked: boolean) => Promise<unknown>;
  onToggleSuccess?: (checked: boolean) => void;
  onToggleError?: (error: unknown, checked: boolean) => void;
};

const OptimisticSwitch = React.forwardRef<React.ComponentRef<typeof SwitchPrimitives.Root>, OptimisticSwitchProps>(
  ({ checked, disabled, onCheckedChangeAsync, onToggleSuccess, onToggleError, ...props }, ref) => {
    const [visualChecked, setVisualChecked] = React.useState(checked);
    const [isPending, setIsPending] = React.useState(false);
    const confirmedRef = React.useRef(checked);
    const desiredRef = React.useRef(checked);
    const runningRef = React.useRef(false);
    const mountedRef = React.useRef(true);
    const externalCheckedRef = React.useRef(checked);
    const callbacksRef = React.useRef({ onCheckedChangeAsync, onToggleSuccess, onToggleError });
    externalCheckedRef.current = checked;
    callbacksRef.current = { onCheckedChangeAsync, onToggleSuccess, onToggleError };

    React.useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
      };
    }, []);

    React.useEffect(() => {
      if (runningRef.current) return;
      confirmedRef.current = checked;
      desiredRef.current = checked;
      setVisualChecked(checked);
    }, [checked]);

    const runQueue = React.useCallback(async () => {
      if (runningRef.current) return;
      runningRef.current = true;
      if (mountedRef.current) setIsPending(true);
      try {
        while (desiredRef.current !== confirmedRef.current) {
          const nextChecked = desiredRef.current;
          try {
            await callbacksRef.current.onCheckedChangeAsync(nextChecked);
          } catch (error) {
            if (desiredRef.current === nextChecked) {
              desiredRef.current = confirmedRef.current;
              if (mountedRef.current) setVisualChecked(confirmedRef.current);
            }
            callbacksRef.current.onToggleError?.(error, nextChecked);
            continue;
          }

          confirmedRef.current = nextChecked;
          if (desiredRef.current === nextChecked) {
            callbacksRef.current.onToggleSuccess?.(nextChecked);
          }
        }
      } finally {
        runningRef.current = false;
        if (mountedRef.current) {
          setIsPending(false);
          /*
            队列跑完就以外部值为准，不管它和我们刚发出去的那个一不一样。

            原来这里只在两者相等时才回同步 —— 隐含假设是「请求什么，服务端就会变成
            什么」。而不相等恰恰是最该说出来的情形：给一个超额的用户开「转发」，
            服务端记下了意图但重算后生效值仍然是关，开关却一直亮着，刷新前谁也看
            不出来。外部值一时还没跟上的话，下面那个 effect 会在它到达时再同步一次
            （此刻 runningRef 已经清了，不会再被跳过）。
          */
          const settled = settledToggleChecked(externalCheckedRef.current, confirmedRef.current);
          confirmedRef.current = settled;
          desiredRef.current = settled;
          setVisualChecked(settled);
        }
      }
    }, []);

    return (
      <Switch
        {...props}
        ref={ref}
        checked={visualChecked}
        disabled={disabled}
        aria-busy={isPending || undefined}
        data-pending={isPending ? "true" : "false"}
        onCheckedChange={(nextChecked) => {
          desiredRef.current = nextChecked;
          setVisualChecked(nextChecked);
          void runQueue();
        }}
      />
    );
  },
)
OptimisticSwitch.displayName = "OptimisticSwitch"

export { OptimisticSwitch, Switch }
