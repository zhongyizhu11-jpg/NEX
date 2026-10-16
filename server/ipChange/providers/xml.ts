/*
  极简 XML 解析：只为读 AWS EC2 Query API 的响应（无属性需求、无 CDATA、无混合内容）。
  不处理 DTD / 实体声明，只解码五个预定义实体和数字字符引用。
*/

export type XmlNode = { name: string; children: XmlNode[]; text: string };

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", children: [], text: "" };
  const stack: XmlNode[] = [root];
  const source = String(xml || "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const re = /<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const top = stack[stack.length - 1];
    if (match[5] !== undefined) {
      top.text += decodeEntities(match[5]);
      continue;
    }
    const [, closing, rawName, , selfClosing] = match;
    const name = rawName.includes(":") ? rawName.slice(rawName.indexOf(":") + 1) : rawName;
    if (closing) {
      // 容错：弹到同名节点为止
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const node: XmlNode = { name, children: [], text: "" };
    top.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

export function xmlChild(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((child) => child.name === name);
}

/** 按路径取节点，例如 "reservationSet/item/instancesSet/item"（每段取第一个同名子节点）。 */
export function xmlPath(node: XmlNode | undefined, path: string): XmlNode | undefined {
  let current = node;
  for (const part of path.split("/")) {
    if (!part) continue;
    current = xmlChild(current, part);
    if (!current) return undefined;
  }
  return current;
}

/** 取某个 xxxSet 下的所有 <item>。 */
export function xmlItems(node: XmlNode | undefined, setPath: string): XmlNode[] {
  const set = xmlPath(node, setPath);
  return set ? set.children.filter((child) => child.name === "item") : [];
}

export function xmlText(node: XmlNode | undefined, path: string): string {
  const target = xmlPath(node, path);
  return target ? target.text.trim() : "";
}

/** 在整棵树里找第一个同名节点（深度优先），用来取错误码这类位置不固定的字段。 */
export function xmlFind(node: XmlNode | undefined, name: string): XmlNode | undefined {
  if (!node) return undefined;
  for (const child of node.children) {
    if (child.name === name) return child;
    const found = xmlFind(child, name);
    if (found) return found;
  }
  return undefined;
}
