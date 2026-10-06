import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProxyRulePlan,
  mihomoRuleSetUrl,
  normalizeProxyRulePreset,
  proxyRuleCategoriesForPreset,
  proxyRuleCategoryGroupName,
  singboxRuleSetUrl,
  PROXY_RULE_CATEGORIES,
  PROXY_RULE_PRESETS,
  PROXY_RULE_TARGET_DIRECT,
  PROXY_RULE_TARGET_REJECT,
} from "./proxyRuleset";

const PLAN_OPTIONS = { mainGroupName: "NEX", selectableMembers: ["HKT 自动选路", "广州1 → HKT"] };

test("不带规则时什么都不生成", () => {
  const plan = buildProxyRulePlan({ preset: "off", ...PLAN_OPTIONS });

  assert.deepEqual(plan.ruleSets, []);
  assert.deepEqual(plan.categoryGroups, []);
  // 仍然要有兜底，否则客户端不知道其余流量往哪走。
  assert.deepEqual(plan.rules, [{ type: "match", target: "NEX" }]);
});

test("预设逐级包含，完整包含均衡、均衡包含精简", () => {
  const keys = (preset: "minimal" | "balanced" | "comprehensive") =>
    new Set(proxyRuleCategoriesForPreset(preset).map((category) => category.key));

  const minimal = keys("minimal");
  const balanced = keys("balanced");
  const comprehensive = keys("comprehensive");

  for (const key of minimal) assert.ok(balanced.has(key), `均衡缺少精简里的 ${key}`);
  for (const key of balanced) assert.ok(comprehensive.has(key), `完整缺少均衡里的 ${key}`);
  assert.ok(minimal.size < balanced.size);
  assert.ok(balanced.size < comprehensive.size);
});

test("规则顺序：局域网和广告在前，国内直连在所有服务之后", () => {
  const plan = buildProxyRulePlan({ preset: "comprehensive", ...PLAN_OPTIONS });
  const order = plan.rules
    .map((rule) => (rule.type === "rule-set" ? rule.ruleSet : rule.type))
    .filter((name) => name !== "ip-private");

  const first = order.indexOf("private");
  const ads = order.indexOf("ads");
  const youtube = order.indexOf("youtube");
  const cn = order.indexOf("cn");
  const match = order.indexOf("match");

  assert.ok(first >= 0 && ads >= 0 && youtube >= 0 && cn >= 0);
  assert.ok(first < ads, "局域网应在广告之前");
  assert.ok(ads < youtube, "广告应在各服务之前");
  // 命中即止：国内规则若排在油管之前，youtube.com 会被当成国内域名直连。
  assert.ok(youtube < cn, "国内直连必须排在各服务之后");
  assert.equal(match, order.length - 1, "兜底必须是最后一条");
});

test("广告直接拦截，不建策略组", () => {
  const plan = buildProxyRulePlan({ preset: "minimal", ...PLAN_OPTIONS });

  const adsRule = plan.rules.find((rule) => rule.type === "rule-set" && rule.ruleSet === "ads");
  assert.equal(adsRule && adsRule.type === "rule-set" ? adsRule.target : "", PROXY_RULE_TARGET_REJECT);
  // 拦截没有可选项，给它一个策略组只会让客户端多一行噪音。
  assert.ok(!plan.categoryGroups.some((group) => group.name.includes("广告")));
});

test("其余分类各建一个策略组，首选项即默认去向", () => {
  const plan = buildProxyRulePlan({ preset: "balanced", ...PLAN_OPTIONS });

  const cn = plan.categoryGroups.find((group) => group.name.includes("国内直连"));
  assert.ok(cn);
  // 国内默认直连，但用户仍能在客户端里改成走代理。
  assert.equal(cn!.members[0], PROXY_RULE_TARGET_DIRECT);
  assert.equal(cn!.members[1], "NEX");

  const ai = plan.categoryGroups.find((group) => group.name.includes("AI"));
  assert.ok(ai);
  assert.equal(ai!.members[0], "NEX");
  assert.equal(ai!.members[1], PROXY_RULE_TARGET_DIRECT);
  // 自动选路组和各节点都能选，这样单独给 AI 指定一条中转也可以。
  assert.ok(ai!.members.includes("HKT 自动选路"));
  assert.ok(ai!.members.includes("广州1 → HKT"));
});

test("局域网用原生私有网段判断，不引用外部规则集", () => {
  const plan = buildProxyRulePlan({ preset: "minimal", ...PLAN_OPTIONS });

  assert.ok(plan.rules.some((rule) => rule.type === "ip-private"));
  // 少一个下载依赖，也少一个 404 的可能。
  assert.ok(!plan.ruleSets.some((ref) => ref.behavior === "ipcidr" && ref.geoKey === "private"));
});

test("sing-box 侧不存在的上游键被标记为仅 mihomo 可用", () => {
  const plan = buildProxyRulePlan({ preset: "comprehensive", ...PLAN_OPTIONS });

  // sing-geosite 里没有 biliintl，逐个实拉验证得出。
  const biliintl = plan.ruleSets.find((item) => item.geoKey === "biliintl");
  assert.equal(biliintl?.mihomoOnly, true);

  // sing-geoip 只按国家代码发布，telegram / netflix 在那边是 404。
  for (const key of ["telegram-ip", "netflix-ip"]) {
    const ref = plan.ruleSets.find((item) => item.name === key);
    assert.ok(ref, `缺少 ${key}`);
    assert.equal(ref!.mihomoOnly, true, `${key} 未标记为仅 mihomo`);
  }
  // 国家代码的 IP 集两边都有。
  const cnIp = plan.ruleSets.find((item) => item.name === "cn-ip");
  assert.equal(cnIp?.mihomoOnly, undefined);
});

test("多个上游键的分类，规则集名带序号且不含非法字符", () => {
  const plan = buildProxyRulePlan({ preset: "balanced", ...PLAN_OPTIONS });
  const aiSets = plan.ruleSets.filter((ref) => ref.name.startsWith("ai"));

  assert.equal(aiSets.length, 2);
  assert.deepEqual(aiSets.map((ref) => ref.name), ["ai-1", "ai-2"]);
  // 上游键里带 `!`，直接拿来当标识符不安全。
  assert.equal(aiSets[0].geoKey, "category-ai-!cn");
  for (const ref of plan.ruleSets) {
    assert.match(ref.name, /^[a-z0-9-]+$/, `规则集名含非法字符: ${ref.name}`);
  }
});

test("规则集名称在一份订阅里唯一", () => {
  for (const preset of PROXY_RULE_PRESETS) {
    const plan = buildProxyRulePlan({ preset, ...PLAN_OPTIONS });
    const names = plan.ruleSets.map((ref) => ref.name);
    assert.equal(new Set(names).size, names.length, `${preset} 有重名规则集`);
  }
});

test("每条规则引用的规则集都真实存在", () => {
  for (const preset of PROXY_RULE_PRESETS) {
    const plan = buildProxyRulePlan({ preset, ...PLAN_OPTIONS });
    const names = new Set(plan.ruleSets.map((ref) => ref.name));
    for (const rule of plan.rules) {
      if (rule.type === "rule-set") {
        assert.ok(names.has(rule.ruleSet), `${preset} 的规则引用了不存在的 ${rule.ruleSet}`);
      }
    }
  }
});

test("规则指向的策略组都真实存在", () => {
  for (const preset of PROXY_RULE_PRESETS) {
    const plan = buildProxyRulePlan({ preset, ...PLAN_OPTIONS });
    const groups = new Set([
      ...plan.categoryGroups.map((group) => group.name),
      "NEX",
      PROXY_RULE_TARGET_DIRECT,
      PROXY_RULE_TARGET_REJECT,
    ]);
    for (const rule of plan.rules) {
      // 指向不存在的组会让客户端拒绝整份配置，不是少一条规则那么简单。
      assert.ok(groups.has(rule.target), `${preset} 的规则指向了不存在的组 ${rule.target}`);
    }
  }
});

test("分类目录本身没有重复键或缺失字段", () => {
  const keys = PROXY_RULE_CATEGORIES.map((category) => category.key);
  assert.equal(new Set(keys).size, keys.length, "分类键重复");

  for (const category of PROXY_RULE_CATEGORIES) {
    assert.match(category.key, /^[a-z0-9-]+$/, `分类键含非法字符: ${category.key}`);
    assert.ok(category.label, `${category.key} 缺少显示名`);
    assert.ok(category.siteKeys.length > 0 || (category.ipKeys?.length ?? 0) > 0 || category.privateIp,
      `${category.key} 没有任何规则来源`);
    assert.ok(category.presets.length > 0, `${category.key} 不属于任何预设`);
  }

  const names = PROXY_RULE_CATEGORIES.map(proxyRuleCategoryGroupName);
  assert.equal(new Set(names).size, names.length, "策略组名重复");
});

test("两家的规则集地址按各自的仓库结构拼", () => {
  assert.equal(
    mihomoRuleSetUrl({ name: "cn", behavior: "domain", geoKey: "cn" }),
    "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/cn.mrs",
  );
  assert.equal(
    mihomoRuleSetUrl({ name: "cn-ip", behavior: "ipcidr", geoKey: "cn" }),
    "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geoip/cn.mrs",
  );
  assert.equal(
    singboxRuleSetUrl({ name: "cn", behavior: "domain", geoKey: "cn" }),
    "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs",
  );
  assert.equal(
    singboxRuleSetUrl({ name: "cn-ip", behavior: "ipcidr", geoKey: "cn" }),
    "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs",
  );
});

test("预设取值收敛，未知值不带规则", () => {
  assert.equal(normalizeProxyRulePreset("balanced"), "balanced");
  assert.equal(normalizeProxyRulePreset("COMPREHENSIVE"), "comprehensive");
  // 默认不带规则：老订阅升级后行为不变。
  assert.equal(normalizeProxyRulePreset(undefined), "off");
  assert.equal(normalizeProxyRulePreset("乱填"), "off");
});
