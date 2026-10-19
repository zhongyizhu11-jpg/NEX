import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 2.3.370 之后真机上看过的那几处（「对话框字体全部缩小、尽量一页看全」「画圈的去掉」）。
 * 守在源码上：以后有人照老样子写回去，这里会报出来。
 */
const read = (relative: string) => fs.readFileSync(path.resolve(import.meta.dirname, relative), "utf8");

function slice(source: string, from: string, to: string) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `找得到 ${from} … ${to}`);
  return source.slice(start, end);
}

test("创建转发对话框里不再有「流量将经过」那块预览", () => {
  /*
    手机上它 208px 高，说的事上面都写了：选中线路下面那一行就是路径，缺什么由按钮旁边那句说。
    用户在真机截图上把它圈出来要求去掉。
  */
  const rules = read("../pages/Rules.tsx");
  assert.doesNotMatch(rules, /流量将经过<\/p>|buildRuleFormPreview/);
  // 反向对照：取到的确实是那个对话框
  assert.match(rules, /<DialogTitle>\{editingId \? "编辑规则" : "添加转发规则"\}<\/DialogTitle>/);
});

test("「＋ 新建隧道」在标签那一行，不再自己占一行、也不再套一个描边灰框", () => {
  const rules = read("../pages/Rules.tsx");
  // 选的是叠加时标签写「使用叠加」、不放新建按钮（叠加在链路管理里建），按钮仍在标签那一行。
  assert.match(rules, /<Label>\{selectedTunnelIsAggregate \? "使用叠加" : "使用隧道"\}<\/Label>\s*\{\/\*[^]*?\*\/\}\s*\{selectedTunnelIsAggregate \? null : renderInlineLinkTrigger\("tunnel"\)\}/);
  assert.doesNotMatch(rules, /space-y-2 rounded-md border border-border bg-muted\/30 p-2\.5/);
});

test("Token 卡、服务卡：一个值一个框改成细线下的小表", () => {
  const token = slice(read("AgentTokenManager.tsx"), "function AgentTokenCard(", "\n}\n");
  const service = slice(read("hosts/HostProbeServiceManager.tsx"), "function ServiceCard(", "\n}\n");
  for (const [name, card] of [["Token 卡", token], ["服务卡", service]] as const) {
    assert.doesNotMatch(card, /rounded-md border|rounded-md bg-muted\/25/, `${name}里不再套小框`);
    assert.match(card, /<dl className="grid grid-cols-\[auto_minmax\(0,1fr\)\][^"]*border-t/, `${name}用细线下的小表`);
    assert.match(card, /<CardActions>/, `反向对照：取到的确实是${name}`);
  }
  // 服务卡上那个数是探测间隔，不是「运行时间」（去掉注释再查：注释里记着原来那个错的叫法）
  const serviceCode = read("hosts/HostProbeServiceManager.tsx").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(serviceCode, /运行时间/);
  assert.match(serviceCode, /探测间隔/);
});

test("Token、服务两个列表不再套一张大白卡（手机上内容离屏幕边 48px 的来源）", () => {
  for (const file of ["AgentTokenManager.tsx", "hosts/HostProbeServiceManager.tsx"]) {
    const source = read(file);
    assert.doesNotMatch(source, /<CardContent className="p-0">/, `${file} 的列表外面没有 p-0 的大卡`);
    // 表格视图单独一块白底
    assert.match(source, /hidden overflow-x-auto rounded-\[var\(--fx-radius-surface\)\] border border-\[var\(--fx-stroke-weak\)\] bg-\[var\(--fx-l1-surface\)\] sm:block/);
  }
});
