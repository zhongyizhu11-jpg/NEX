import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { describeGroupRoutePolicy } from "@shared/routePolicy";
import { GroupFailoverPolicyFields, type GroupFailoverPolicyValue } from "./GroupFailoverPolicyFields";

type FormPatch = Partial<GroupFailoverPolicyValue> & { domain?: string; isEnabled?: boolean };

function render(patch: FormPatch = {}, ddnsSwitching?: boolean) {
  const value: GroupFailoverPolicyValue = {
    failoverSeconds: "60",
    recoverSeconds: "120",
    autoFailback: true,
    chinaHealthCheckEnabled: false,
    chinaHealthCheckTarget: "",
    chinaHealthCheckMethod: "tcp",
    ...patch,
  };
  // 和编辑框一样：拿表单现在的样子走同一份模型，按「有规则在用」来算。
  const policy = describeGroupRoutePolicy({
    groupMode: "failover",
    isEnabled: patch.isEnabled ?? true,
    domain: patch.domain ?? "hk.example.com",
    recordType: "A",
    ...value,
    templateRuleCount: 1,
    members: [
      { memberType: "host", hostId: 1, priority: 0, isEnabled: true, host: { name: "HK entry 01" } },
      { memberType: "host", hostId: 2, priority: 1, isEnabled: false, host: { name: "JP entry 02" } },
      { memberType: "host", hostId: 3, priority: 2, isEnabled: true, host: { name: "SG entry 03" } },
    ],
  }, { ddnsSwitching });
  return renderToStaticMarkup(<GroupFailoverPolicyFields value={value} onChange={() => {}} policy={policy} ddnsSwitching={ddnsSwitching} />);
}

const orderState = (html: string) => html.match(/data-state="(\w+)" data-testid="group-policy-order"/)?.[1];

test("按什么选：一行「按成员顺序」，列的是表单里启用着的成员；会切的时候标「此刻」", () => {
  const html = render();
  assert.match(html, /按成员顺序/);
  assert.match(html, /HK entry 01 → SG entry 03/, "停用的 JP 不在顺序里");
  assert.equal(orderState(html), "deciding");
  assert.equal((html.match(/>此刻</g) || []).length, 1);
  assert.match(html, /顺序就是上面「成员优先级」的顺序/);
});

test("组停用、没填域名：不会切，「此刻」不亮；没填域名时明说这两个时间用不上", () => {
  assert.equal(orderState(render({ isEnabled: false })), "idle");
  const noDomain = render({ domain: "" });
  assert.equal(orderState(noDomain), "idle");
  assert.match(noDomain, /没填 DDNS 域名就没有解析可切/);
  assert.doesNotMatch(noDomain, /Agent 已判定失败的不等/);
});

test("什么时候切：下面那两句跟着还没保存的秒数和勾选框变", () => {
  const html = render({ failoverSeconds: "90", recoverSeconds: "300" });
  assert.match(html, /在用的成员不健康满 90 秒就换下一个健康的；Agent 已判定失败的不等/);
  assert.match(html, /否则等它稳定 5 分钟/);
  const noFailback = render({ autoFailback: false });
  assert.match(noFailback, /在用的成员不出问题就一直用它/);
  assert.doesNotMatch(noFailback, /否则等它稳定/);
});

test("系统 DDNS 没开时明说不会真的切；开着、或者还不知道时不说", () => {
  assert.match(render({}, false), /系统 DDNS 没开：挑出来的只记成建议入口，解析不会改/);
  assert.doesNotMatch(render({}, true), /系统 DDNS 没开/);
  assert.doesNotMatch(render(), /系统 DDNS 没开/);
});

test("怎么算健康：入口检测没开时不摊开目标和方式；开了之后「怎么算健康」那句写上目标", () => {
  const off = render();
  assert.match(off, /成员上的转发在跑、Agent 探测通过/);
  assert.doesNotMatch(off, /检测目标/);
  const on = render({ chinaHealthCheckEnabled: true, chinaHealthCheckTarget: "1.2.4.8:443" });
  assert.match(on, /检测目标/);
  assert.match(on, /value="1\.2\.4\.8:443"/);
  assert.match(on, /而且从成员上 TCPing 1\.2\.4\.8:443 能通/);
});

test("换检测方式：目标还是上一种的默认值就跟着换（UDP 不能拿 :80 去探），自己填的留着", async () => {
  const { healthCheckMethodPatch } = await import("./GroupFailoverPolicyFields");
  assert.deepEqual(healthCheckMethodPatch("tcp", "udp", "www.189.cn:80"), { chinaHealthCheckMethod: "udp", chinaHealthCheckTarget: "223.5.5.5:53" });
  assert.deepEqual(healthCheckMethodPatch("udp", "ping", "223.5.5.5:53"), { chinaHealthCheckMethod: "ping", chinaHealthCheckTarget: "www.189.cn" });
  assert.deepEqual(healthCheckMethodPatch("tcp", "udp", "dns.example.cn:5353"), { chinaHealthCheckMethod: "udp" }, "自己填的目标不动");
  assert.deepEqual(healthCheckMethodPatch("tcp", "udp", ""), { chinaHealthCheckMethod: "udp" }, "空着就让面板按方式取默认");
  assert.deepEqual(healthCheckMethodPatch("tcp", "tcp", "www.189.cn:80"), { chinaHealthCheckMethod: "tcp" });
});
