import { hasCjk } from "./translate";

/*
  英文界面的「运行时翻译」：页面照旧用中文渲染，这里在浏览器画出来之前把文字节点和几个属性换成英文。

  为什么不是给每句话包 t()：13 万行前端全是写死的中文，全包一遍等于重写，还会和所有在改的分支冲突。

  和 React 相处的规矩（破了就会出 removeChild / insertBefore 报错、或者字换不回来）：
  · 只改已有文字节点的 nodeValue、已有元素的属性值，绝不新建 / 替换 / 包裹 / 挪动节点——
    React 手里攥着这些节点的引用，下次更新还要拿它们 insertBefore / removeChild。
  · React 更新文字是直接把新中文写进同一个节点的 nodeValue，观察器看到 characterData 变化再翻一次；
    React 比的是自己记的旧 props，不读 DOM，所以我们写进去的英文它不会「纠正」回来。
  · 每个节点记下原文（WeakMap，节点被 React 扔掉就跟着回收），切回中文时原地还原，不用刷新。
  · 一个元素下面全是文字节点（JSX 的「共 {total} 条」会拆成三段）时整组拼起来翻：
    英文写进第一段，其余段写成空串；哪段被 React 改了，按记下的原文重新拼一次。
  · 只碰含汉字的文字；<script>/<style>/<code>/<pre>/<textarea>、contenteditable、
    data-no-translate 里面的一律不动（规则名、主机名、日志、主题 CSS、公告正文这些用户数据）。
  · 观察器回调只登记，攒到下一帧 requestAnimationFrame 里一次处理（rAF 在绘制之前跑，不会闪中文）；
    处理完把自己改动引出的记录 takeRecords() 丢掉，不会自己触发自己。
  · 中文界面根本不挂观察器，零开销。
*/

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

export const TRANSLATED_ATTRIBUTES = ["placeholder", "title", "aria-label", "alt"] as const;
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "TEXTAREA", "KBD", "SAMP", "TEMPLATE"]);

/** 测试用的假 DOM 只需要实现这几样 */
interface MinimalNode {
  nodeType: number;
  nodeValue: string | null;
  parentNode: MinimalNode | null;
  childNodes: ArrayLike<MinimalNode>;
  isConnected?: boolean;
}
interface MinimalElement extends MinimalNode {
  tagName: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  hasAttribute(name: string): boolean;
}

interface Recorded {
  source: string;
  written: string;
}

export interface DomTranslatorStats {
  flushes: number;
  nodes: number;
  translated: number;
  totalMs: number;
  maxMs: number;
}

export interface DomTranslatorOptions {
  root: () => Node | MinimalNode | null;
  translate: (text: string) => string | null;
  MutationObserver?: typeof MutationObserver | null;
  schedule?: (callback: () => void) => void;
  now?: () => number;
}

export interface DomTranslator {
  start(): void;
  stop(): void;
  readonly active: boolean;
  /** 立刻翻一棵子树（测试、以及 start 时的首轮） */
  translateSubtree(node: Node | MinimalNode): void;
  /** 把观察器的记录喂进来（测试里直接调） */
  handleRecords(records: ArrayLike<Pick<MutationRecord, "type" | "target" | "addedNodes" | "attributeName">>): void;
  /** 立刻处理攒着的变化 */
  flush(): void;
  /** 把翻过的字原地还原成中文 */
  restore(): void;
  readonly stats: DomTranslatorStats;
}

function isElement(node: MinimalNode): node is MinimalElement {
  return node.nodeType === ELEMENT_NODE;
}

function isSkippedElement(element: MinimalElement): boolean {
  if (SKIP_TAGS.has(String(element.tagName).toUpperCase())) return true;
  if (element.hasAttribute("data-no-translate")) return true;
  const editable = element.getAttribute("contenteditable");
  return editable != null && editable !== "false";
}

export function createDomTranslator(options: DomTranslatorOptions): DomTranslator {
  const texts = new WeakMap<MinimalNode, Recorded>();
  const attributes = new WeakMap<MinimalElement, Map<string, Recorded>>();
  const pendingNodes = new Set<MinimalNode>();
  const pendingAttributes = new Map<MinimalElement, Set<string>>();
  const now = options.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const schedule = options.schedule ?? ((callback: () => void) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(callback);
    else setTimeout(callback, 16);
  });
  const stats: DomTranslatorStats = { flushes: 0, nodes: 0, translated: 0, totalMs: 0, maxMs: 0 };

  let active = false;
  let scheduled = false;
  let observer: MutationObserver | null = null;
  // 一次处理里「这个元素是不是在跳过区里」只算一遍
  let skipCache = new Map<MinimalNode, boolean>();
  let doneGroups = new Set<MinimalNode>();

  function insideSkipped(node: MinimalNode | null): boolean {
    const chain: MinimalNode[] = [];
    let current = node;
    let result = false;
    while (current) {
      const cached = skipCache.get(current);
      if (cached !== undefined) {
        result = cached;
        break;
      }
      chain.push(current);
      if (isElement(current) && isSkippedElement(current)) {
        result = true;
        break;
      }
      current = current.parentNode;
    }
    for (const item of chain) skipCache.set(item, result);
    return result;
  }

  function sourceOf(node: MinimalNode): string {
    const value = node.nodeValue ?? "";
    const record = texts.get(node);
    return record && record.written === value ? record.source : value;
  }

  function write(node: MinimalNode, source: string, output: string) {
    if (output === source) texts.delete(node);
    else texts.set(node, { source, written: output });
    if (node.nodeValue !== output) {
      node.nodeValue = output;
      stats.translated += 1;
    }
  }

  function isTextGroup(element: MinimalNode): boolean {
    const children = element.childNodes;
    if (children.length < 2) return false;
    for (let index = 0; index < children.length; index += 1) {
      if (children[index].nodeType !== TEXT_NODE) return false;
    }
    return true;
  }

  function translateGroup(element: MinimalNode) {
    if (doneGroups.has(element)) return;
    doneGroups.add(element);
    const children = Array.from(element.childNodes);
    const sources = children.map(sourceOf);
    if (!sources.some(hasCjk) && !children.some((child) => texts.has(child))) return;
    const joined = sources.join("");
    const output = hasCjk(joined) ? options.translate(joined) : null;
    if (output != null) {
      children.forEach((child, index) => write(child, sources[index], index === 0 ? output : ""));
      return;
    }
    // 整组对不上：一段一段翻，之前整组翻过的（第一段里是整句英文、其余是空串）先还原
    children.forEach((child, index) => {
      const source = sources[index];
      write(child, source, (hasCjk(source) ? options.translate(source) : null) ?? source);
    });
  }

  function translateText(node: MinimalNode) {
    stats.nodes += 1;
    const parent = node.parentNode;
    if (parent && isElement(parent) && isTextGroup(parent)) {
      translateGroup(parent);
      return;
    }
    const source = sourceOf(node);
    if (!hasCjk(source)) {
      if (texts.has(node)) write(node, source, source);
      return;
    }
    write(node, source, options.translate(source) ?? source);
  }

  function translateAttribute(element: MinimalElement, name: string) {
    const value = element.getAttribute(name);
    const records = attributes.get(element);
    const record = records?.get(name);
    if (value == null) {
      records?.delete(name);
      return;
    }
    const source = record && record.written === value ? record.source : value;
    if (!hasCjk(source)) {
      records?.delete(name);
      return;
    }
    const output = options.translate(source);
    if (output == null || output === source) {
      records?.delete(name);
      if (value !== source) element.setAttribute(name, source);
      return;
    }
    const map = records ?? new Map<string, Recorded>();
    map.set(name, { source, written: output });
    attributes.set(element, map);
    if (value !== output) element.setAttribute(name, output);
  }

  function translateAttributes(element: MinimalElement) {
    for (const name of TRANSLATED_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value != null && (hasCjk(value) || attributes.get(element)?.has(name))) translateAttribute(element, name);
    }
  }

  function walk(start: MinimalNode) {
    const stack: MinimalNode[] = [start];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.nodeType === TEXT_NODE) {
        if (hasCjk(node.nodeValue) || texts.has(node)) translateText(node);
        continue;
      }
      if (!isElement(node)) {
        // DocumentFragment / Document：只往下走
        for (let index = node.childNodes?.length ?? 0; index > 0; index -= 1) stack.push(node.childNodes[index - 1]);
        continue;
      }
      if (isSkippedElement(node)) continue;
      translateAttributes(node);
      for (let index = node.childNodes.length; index > 0; index -= 1) stack.push(node.childNodes[index - 1]);
    }
  }

  function translateSubtree(node: Node | MinimalNode) {
    const target = node as MinimalNode;
    if (target.nodeType === TEXT_NODE) {
      if (!insideSkipped(target.parentNode)) translateText(target);
      return;
    }
    if (insideSkipped(target.parentNode)) return;
    walk(target);
  }

  function flush() {
    scheduled = false;
    if (!active && pendingNodes.size === 0 && pendingAttributes.size === 0) return;
    const started = now();
    skipCache = new Map();
    doneGroups = new Set();
    const nodes = Array.from(pendingNodes);
    const attrs = Array.from(pendingAttributes);
    pendingNodes.clear();
    pendingAttributes.clear();
    for (const node of nodes) {
      if (node.isConnected === false) continue;
      translateSubtree(node);
    }
    for (const [element, names] of attrs) {
      if (element.isConnected === false || insideSkipped(element)) continue;
      for (const name of names) translateAttribute(element, name);
    }
    // 自己刚写进去的改动也会排进观察器，丢掉，免得下一帧又处理一遍
    observer?.takeRecords();
    skipCache = new Map();
    doneGroups = new Set();
    const elapsed = now() - started;
    stats.flushes += 1;
    stats.totalMs += elapsed;
    stats.maxMs = Math.max(stats.maxMs, elapsed);
  }

  function requestFlush() {
    if (scheduled) return;
    scheduled = true;
    schedule(flush);
  }

  function handleRecords(records: ArrayLike<Pick<MutationRecord, "type" | "target" | "addedNodes" | "attributeName">>) {
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const target = record.target as unknown as MinimalNode;
      if (record.type === "characterData") {
        if (hasCjk(target.nodeValue) || texts.has(target)) pendingNodes.add(target);
      } else if (record.type === "childList") {
        for (let i = 0; i < record.addedNodes.length; i += 1) pendingNodes.add(record.addedNodes[i] as unknown as MinimalNode);
        // 一组文字节点少了 / 多了一段：整组按原文重拼（只看直接子节点，不重扫整棵树）
        if (isElement(target) && (isTextGroup(target) || Array.from(target.childNodes).some((child) => texts.has(child)))) {
          for (const child of Array.from(target.childNodes)) if (child.nodeType === TEXT_NODE) pendingNodes.add(child);
        }
      } else if (record.type === "attributes" && record.attributeName && isElement(target)) {
        const names = pendingAttributes.get(target) ?? new Set<string>();
        names.add(record.attributeName);
        pendingAttributes.set(target, names);
      }
    }
    if (pendingNodes.size || pendingAttributes.size) requestFlush();
  }

  function restore() {
    const root = options.root() as MinimalNode | null;
    if (!root) return;
    const stack: MinimalNode[] = [root];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.nodeType === TEXT_NODE) {
        const record = texts.get(node);
        if (record) {
          if (node.nodeValue === record.written) node.nodeValue = record.source;
          texts.delete(node);
        }
        continue;
      }
      if (isElement(node)) {
        const records = attributes.get(node);
        if (records) {
          for (const [name, record] of records) {
            if (node.getAttribute(name) === record.written) node.setAttribute(name, record.source);
          }
          attributes.delete(node);
        }
      }
      const children = node.childNodes;
      for (let index = children?.length ?? 0; index > 0; index -= 1) stack.push(children[index - 1]);
    }
  }

  return {
    start() {
      if (active) return;
      const root = options.root();
      if (!root) return;
      active = true;
      const started = now();
      skipCache = new Map();
      doneGroups = new Set();
      walk(root as MinimalNode);
      skipCache = new Map();
      doneGroups = new Set();
      const elapsed = now() - started;
      stats.totalMs += elapsed;
      stats.maxMs = Math.max(stats.maxMs, elapsed);
      const Observer = options.MutationObserver === undefined
        ? (typeof MutationObserver === "function" ? MutationObserver : null)
        : options.MutationObserver;
      if (Observer) {
        observer = new Observer((records) => handleRecords(records));
        observer.observe(root as Node, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: [...TRANSLATED_ATTRIBUTES],
        });
      }
    },
    stop() {
      if (!active) return;
      active = false;
      observer?.disconnect();
      observer = null;
      pendingNodes.clear();
      pendingAttributes.clear();
      restore();
    },
    get active() {
      return active;
    },
    translateSubtree,
    handleRecords,
    flush,
    restore,
    stats,
  };
}
