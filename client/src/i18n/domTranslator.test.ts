import assert from "node:assert/strict";
import test from "node:test";
import { createDomTranslator } from "./domTranslator";
import { PATTERNS } from "./patterns";
import { createTranslator } from "./translate";

/*
  最小的假 DOM：只有翻译器用到的那几样。每个节点数一下 nodeValue / 属性被写了几次、
  childNodes 有没有被动过——翻译器只许原地改值，不许增删换节点（那是 React 的）。
*/
class FakeNode {
  parentNode: FakeElement | null = null;
  childNodes: FakeNode[] = [];
  constructor(public nodeType: number, private value: string | null = null) {}
  writes = 0;
  get nodeValue() {
    return this.value;
  }
  set nodeValue(next: string | null) {
    this.writes += 1;
    this.value = next;
  }
  get isConnected(): boolean {
    let current: FakeNode | null = this;
    while (current.parentNode) current = current.parentNode;
    return current instanceof FakeElement && current.tagName === "BODY";
  }
}

class FakeElement extends FakeNode {
  attrs = new Map<string, string>();
  constructor(public tagName: string, attrs: Record<string, string> = {}, children: Array<FakeNode | string> = []) {
    super(1);
    for (const [key, value] of Object.entries(attrs)) this.attrs.set(key, value);
    for (const child of children) this.append(typeof child === "string" ? new FakeNode(3, child) : child);
  }
  append(child: FakeNode) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  remove(child: FakeNode) {
    this.childNodes = this.childNodes.filter((item) => item !== child);
    child.parentNode = null;
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  hasAttribute(name: string) {
    return this.attrs.has(name);
  }
}

const el = (tag: string, attrs: Record<string, string> = {}, ...children: Array<FakeNode | string>) => new FakeElement(tag.toUpperCase(), attrs, children);
const text = (node: FakeNode) => node.childNodes.map((child) => child.nodeValue).join("");

const translator = createTranslator({
  "保存": "Save",
  "取消": "Cancel",
  "搜索规则": "Search rules",
  "规则名称": "Rule name",
  "共 {0} 条": "{0} total",
  "转发规则": "Forwarding Rules",
  "状态": "Status",
  "在线": "Online",
}, PATTERNS);

function setup(body: FakeElement) {
  const dom = createDomTranslator({
    root: () => body as unknown as Node,
    translate: (value) => translator.translate(value),
    MutationObserver: null,
    schedule: (callback) => callback(),
  });
  return dom;
}

test("只原地改 nodeValue / 属性，保留首尾空白；节点本身一个不动", () => {
  const save = el("button", { title: "保存", "aria-label": "保存" }, " 保存 ");
  const input = el("input", { placeholder: "搜索规则", value: "保存" });
  const body = el("body", {}, el("div", { id: "root" }, save, input, el("span", {}, "English only")));
  const childrenBefore = [...save.childNodes];
  const dom = setup(body);
  dom.start();
  assert.equal(save.childNodes[0].nodeValue, " Save ");
  assert.deepEqual(save.childNodes, childrenBefore, "不替换文字节点");
  assert.equal(save.getAttribute("title"), "Save");
  assert.equal(save.getAttribute("aria-label"), "Save");
  assert.equal(input.getAttribute("placeholder"), "Search rules");
  assert.equal(input.getAttribute("value"), "保存", "输入框的值是用户数据，不翻");
  dom.stop();
  assert.equal(save.childNodes[0].nodeValue, " 保存 ");
  assert.equal(save.getAttribute("title"), "保存");
  assert.equal(input.getAttribute("placeholder"), "搜索规则");
});

test("跳过 data-no-translate、code/pre/textarea/script/style、contenteditable 里的字", () => {
  const user = el("span", { "data-no-translate": "" }, "保存");
  const nested = el("div", { "data-no-translate": "" }, el("b", { title: "保存" }, "保存"));
  const code = el("code", {}, "保存");
  const pre = el("pre", {}, "保存");
  const area = el("textarea", { placeholder: "保存" }, "保存");
  const script = el("script", {}, "保存");
  const style = el("style", {}, "保存");
  const editable = el("div", { contenteditable: "true" }, "保存");
  const notEditable = el("div", { contenteditable: "false" }, "保存");
  const body = el("body", {}, user, nested, code, pre, area, script, style, editable, notEditable);
  const dom = setup(body);
  dom.start();
  for (const node of [user, code, pre, area, script, style, editable]) assert.equal(text(node), "保存", node.tagName);
  assert.equal(text(nested.childNodes[0]), "保存");
  assert.equal((nested.childNodes[0] as FakeElement).getAttribute("title"), "保存");
  assert.equal(area.getAttribute("placeholder"), "保存");
  assert.equal(text(notEditable), "Save");
  // 后来加进跳过区的节点也不翻（祖先检查）
  const late = user.append(new FakeNode(3, "取消"));
  dom.handleRecords([{ type: "childList", target: user as unknown as Node, addedNodes: [late] as unknown as NodeList, attributeName: null }]);
  assert.equal(late.nodeValue, "取消");
  dom.stop();
});

test("React 改了文字（characterData）：按新原文再翻；对不上的留原文；切回中文还原成最新的原文", () => {
  const label = el("span", {}, "保存");
  const body = el("body", {}, label);
  const dom = setup(body);
  dom.start();
  const node = label.childNodes[0];
  assert.equal(node.nodeValue, "Save");
  node.nodeValue = "取消"; // React commitTextUpdate
  dom.handleRecords([{ type: "characterData", target: node as unknown as Node, addedNodes: [] as unknown as NodeList, attributeName: null }]);
  assert.equal(node.nodeValue, "Cancel");
  node.nodeValue = "没有翻译的话";
  dom.handleRecords([{ type: "characterData", target: node as unknown as Node, addedNodes: [] as unknown as NodeList, attributeName: null }]);
  assert.equal(node.nodeValue, "没有翻译的话");
  node.nodeValue = "保存";
  dom.handleRecords([{ type: "characterData", target: node as unknown as Node, addedNodes: [] as unknown as NodeList, attributeName: null }]);
  assert.equal(node.nodeValue, "Save");
  dom.stop();
  assert.equal(node.nodeValue, "保存");
  assert.equal(dom.active, false);
});

test("新挂上的子树（childList）和改过的属性（attributes）都翻；中文界面不挂观察器", () => {
  const root = el("div", { id: "root" });
  const body = el("body", {}, root);
  const dom = setup(body);
  dom.start();
  const dialog = el("div", { role: "dialog" }, el("h2", {}, "转发规则"), el("input", { placeholder: "规则名称" }));
  root.append(dialog);
  dom.handleRecords([{ type: "childList", target: root as unknown as Node, addedNodes: [dialog] as unknown as NodeList, attributeName: null }]);
  assert.equal(text(dialog.childNodes[0]), "Forwarding Rules");
  const input = dialog.childNodes[1] as FakeElement;
  assert.equal(input.getAttribute("placeholder"), "Rule name");
  input.setAttribute("placeholder", "搜索规则");
  dom.handleRecords([{ type: "attributes", target: input as unknown as Node, addedNodes: [] as unknown as NodeList, attributeName: "placeholder" }]);
  assert.equal(input.getAttribute("placeholder"), "Search rules");
  dom.stop();
  assert.equal(input.getAttribute("placeholder"), "搜索规则");
  assert.equal(text(dialog.childNodes[0]), "转发规则");
});

test("一个元素下面全是文字节点（JSX「共 {total} 条」）：整组拼起来翻，任何一段变了重新拼", () => {
  const counter = el("span", {}, "共 ", "12", " 条");
  const status = el("span", {}, "状态", "：", "在线");
  const body = el("body", {}, counter, status);
  const nodes = [...counter.childNodes];
  const dom = setup(body);
  dom.start();
  assert.equal(text(counter), "12 total");
  assert.deepEqual(counter.childNodes, nodes);
  assert.equal(nodes[0].nodeValue, "12 total");
  assert.equal(nodes[1].nodeValue, "");
  assert.equal(text(status), "Status: Online");
  // React 只更新中间那段数字
  nodes[1].nodeValue = "13";
  dom.handleRecords([{ type: "characterData", target: nodes[1] as unknown as Node, addedNodes: [] as unknown as NodeList, attributeName: null }]);
  assert.equal(text(counter), "13 total");
  // React 删掉一段（条件渲染）：剩下的按原文重拼
  counter.remove(nodes[2]);
  dom.handleRecords([{ type: "childList", target: counter as unknown as Node, addedNodes: [] as unknown as NodeList, attributeName: null }]);
  assert.equal(text(counter), "共 13", "对不上模板就逐段还原 / 翻译，不留下半句英文");
  dom.stop();
  assert.equal(text(status), "状态：在线");
  assert.equal(text(counter), "共 13");
});

test("不含汉字的节点不碰：没有一次写入", () => {
  const plain = el("span", {}, "192.168.1.1:443");
  const mixed = el("span", {}, "规则 ABC 很长没有翻译");
  const body = el("body", {}, plain, mixed);
  const dom = setup(body);
  dom.start();
  assert.equal(plain.childNodes[0].writes, 0);
  assert.equal(mixed.childNodes[0].writes, 0);
  assert.equal(text(mixed), "规则 ABC 很长没有翻译");
  dom.stop();
  assert.equal(mixed.childNodes[0].writes, 0);
});
