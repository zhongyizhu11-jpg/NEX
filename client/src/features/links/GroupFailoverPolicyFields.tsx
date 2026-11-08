import { ConditionBlock, PolicyGroup } from "@/features/rules/PolicyBlocks";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  FORWARD_GROUP_HEALTH_CHECK_METHODS,
  FORWARD_GROUP_HEALTH_CHECK_METHOD_HINTS,
  FORWARD_GROUP_HEALTH_CHECK_METHOD_LABELS,
  defaultHealthCheckTarget,
  healthCheckTargetNeedsPort,
  healthCheckTargetPlaceholder,
  normalizeForwardGroupHealthCheckMethod,
  type ForwardGroupHealthCheckMethod,
} from "@shared/forwardGroupHealthCheck";
import type { RoutePolicy } from "@shared/routePolicy";

/*
  转发组编辑框里「故障转移」那一块。

  和点开的策略面板说同一种话：按什么选 → 什么时候切 → 怎么算健康。输入框下面那几句是拿
  **还没保存的表单**、走和面板同一份模型（shared/routePolicy 的 describeGroupRoutePolicy）
  算出来的 —— 改秒数、改开关的时候当场看得见「这样配，面板会怎么做」，不用存了再去卡片上点开看。

  原来这一块是散着的六个控件：一行「单位：秒，范围 10-3600。」、两个秒数、两个勾选框，再加
  一个没有标题的输入框（入口健康度检测的目标 —— 开它的勾选框还在它下面）。读不出「谁决定
  用哪个成员、什么时候换」，成员顺序就是首选顺序这件事，整个编辑框里一个字都没有。
*/

/*
  换检测方式时，目标还是上一种方式的默认值（没动过）就跟着换成这一种的默认值：UDP 拿 TCPing 的 www.189.cn:80 去探，
  80 端口不收 UDP，回个端口不可达就被当成不通，整组成员一起「不健康」。自己填过的目标原样留着。
*/
export function healthCheckMethodPatch(previous: ForwardGroupHealthCheckMethod, next: ForwardGroupHealthCheckMethod, target: string | null | undefined) {
  const current = String(target || "").trim();
  const followsDefault = current !== "" && current === defaultHealthCheckTarget(previous) && next !== previous;
  return followsDefault
    ? { chinaHealthCheckMethod: next, chinaHealthCheckTarget: defaultHealthCheckTarget(next) }
    : { chinaHealthCheckMethod: next };
}

export type GroupFailoverPolicyValue = {
  failoverSeconds: string;
  recoverSeconds: string;
  autoFailback: boolean;
  chinaHealthCheckEnabled: boolean;
  chinaHealthCheckTarget: string;
  chinaHealthCheckMethod: ForwardGroupHealthCheckMethod;
};

export type GroupFailoverPolicyFieldsProps = {
  value: GroupFailoverPolicyValue;
  onChange: (patch: Partial<GroupFailoverPolicyValue>) => void;
  /** 拿表单现在的样子（成员顺序、秒数、开关、域名）算出来的策略。 */
  policy: RoutePolicy | null;
  /** 系统 DDNS 开着没有；不知道（设置还没加载）时不传。 */
  ddnsSwitching?: boolean;
};

export function GroupFailoverPolicyFields({ value, onChange, policy, ddnsSwitching }: GroupFailoverPolicyFieldsProps) {
  const guard = (key: string) => policy?.guards.find((item) => item.key === key)?.value;
  const order = policy?.conditions.find((condition) => condition.kind === "order");
  const method = normalizeForwardGroupHealthCheckMethod(value.chinaHealthCheckMethod);

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="group-failover-policy">
      <PolicyGroup
        title="按什么选"
        note="排在最前、而且健康的成员拿到解析；它不健康了就往下找。顺序就是上面「成员优先级」的顺序，拖动调整。"
      >
        {/*
          系统 DDNS 没开时，这里配得再对也不会真的切：面板只记一个「建议入口」。这件事原来
          只在卡片的状态文字里一闪而过，配的人在编辑框里完全看不到。
        */}
        {ddnsSwitching === false ? (
          <p className="rounded-[var(--fx-radius-control)] bg-[var(--fx-warn-soft)] px-3 py-2 text-xs leading-5 text-[var(--fx-warn-text)]">
            系统 DDNS 没开：挑出来的只记成建议入口，解析不会改。要真的切，先去系统设置里开 DDNS。
          </p>
        ) : null}
        {/* 包一层：条件行靠 first: 去掉第一行的分隔线，前面有警告时它就不是第一个了。 */}
        <div className="flex min-w-0 flex-col">
          <ConditionBlock
            title="按成员顺序"
            detail={order?.then}
            deciding={policy?.deciding === "order"}
            testId="group-policy-order"
          />
        </div>
      </PolicyGroup>

      <PolicyGroup title="什么时候切">
        <div className="grid gap-2 sm:grid-cols-2">
          <FormField className="space-y-2">
            <Label className="flex items-baseline gap-1.5">
              切换时间（秒）
              <span className="text-xs font-normal text-muted-foreground">10–3600</span>
            </Label>
            <Input
              type="number"
              min={10}
              max={3600}
              step={1}
              value={value.failoverSeconds}
              onChange={(event) => onChange({ failoverSeconds: event.target.value })}
              placeholder="60"
            />
          </FormField>
          <FormField className="space-y-2">
            <Label className="flex items-baseline gap-1.5">
              恢复观察（秒）
              <span className="text-xs font-normal text-muted-foreground">10–3600</span>
            </Label>
            <Input
              type="number"
              min={10}
              max={3600}
              step={1}
              value={value.recoverSeconds}
              onChange={(event) => onChange({ recoverSeconds: event.target.value })}
              placeholder="120"
            />
          </FormField>
        </div>
        {/* 这两句会跟着秒数变：「Agent 已判定」那半句最容易被忽略，而它决定了多数时候根本不用等满。 */}
        {guard("failover")
          ? <p className="text-xs leading-5 text-muted-foreground">{guard("failover")}</p>
          : <p className="text-xs leading-5 text-muted-foreground">没填 DDNS 域名就没有解析可切：只看成员健康，这两个时间用不上。</p>}
        <label className="flex w-fit items-start gap-2 text-sm">
          <Checkbox
            checked={value.autoFailback}
            onCheckedChange={(checked) => onChange({ autoFailback: checked === true })}
            aria-label="恢复后切回"
            className="mt-0.5"
          />
          <span className="flex flex-col">
            恢复后切回首选
            {guard("recover") ? <span className="text-xs leading-5 text-muted-foreground">{guard("recover")}</span> : null}
          </span>
        </label>
      </PolicyGroup>

      <PolicyGroup title="怎么算健康">
        {/* 先说规矩，再给开关：开了入口检测，这一句会带上检测目标。 */}
        {guard("health") ? <p className="text-xs leading-5 text-muted-foreground">{guard("health")}</p> : null}
        <label className="flex w-fit items-start gap-2 text-sm">
          <Checkbox
            checked={value.chinaHealthCheckEnabled}
            onCheckedChange={(checked) => onChange({ chinaHealthCheckEnabled: checked === true })}
            aria-label="入口健康度检测"
            className="mt-0.5"
          />
          <span className="flex flex-col">
            再加一道入口健康度检测
            <span className="text-xs leading-5 text-muted-foreground">从每个成员上探一个国内的目标，探不通就算不健康 —— 转发在跑，不等于用户连得上它。</span>
          </span>
        </label>
        {value.chinaHealthCheckEnabled ? (
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,240px)]">
            <FormField className="space-y-2">
              <Label>检测目标</Label>
              <Input
                value={value.chinaHealthCheckTarget}
                onChange={(event) => onChange({ chinaHealthCheckTarget: event.target.value })}
                placeholder={healthCheckTargetPlaceholder(method)}
                className="font-mono text-sm"
                spellCheck={false}
              />
            </FormField>
            <FormField className="space-y-2">
              <Label>检测方式</Label>
              <Select
                value={method}
                onValueChange={(next) => onChange(healthCheckMethodPatch(method, normalizeForwardGroupHealthCheckMethod(next), value.chinaHealthCheckTarget))}
              >
                <SelectTrigger aria-label="健康度检测方式"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FORWARD_GROUP_HEALTH_CHECK_METHODS.map((item) => (
                    <SelectItem key={item} value={item}>
                      {FORWARD_GROUP_HEALTH_CHECK_METHOD_LABELS[item]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <p className="text-xs leading-5 text-muted-foreground sm:col-span-2">
              {FORWARD_GROUP_HEALTH_CHECK_METHOD_HINTS[method]}
              {healthCheckTargetNeedsPort(method) ? " IPv6 格式：[地址]:端口。" : " IPv6 直接填地址。"}
            </p>
          </div>
        ) : null}
      </PolicyGroup>
    </div>
  );
}
