/*
  自定义策略组怎么挑成员：按节点名。

  原来只有一种写法 —— 一个正则（非法时按子串）。会写正则的人没几个，「香港 且 不是 IPLC」
  得写成 `^(?=.*香港)(?!.*IPLC)`，没人记得住。Open-Box 的动态组是关键词逗号分隔、可选
  「命中任一 / 全部命中」，honk 的过滤再多一档 `keyword:` / `regex:` / `!` 取反 / `&&`。
  三种匹配方式并存，老模板不填就是正则，照旧。

    regex  整个表达式是一个正则（非法时当子串）
    any    关键词逗号分隔，命中任一就算
    all    关键词逗号分隔，全部命中才算

  关键词写法（any / all 两种里）：
    香港          名字里含「香港」（不分大小写）
    !IPLC         名字里不能含 IPLC（取反的词永远是排除条件）
    regex:^HK-    这个词是正则
    =香港 01      名字就是「香港 01」
    香港 && 0.5   一个词里用 && 连起来表示都要满足（any 模式下写「或」里面的「且」）

  组是动态的：每次渲染订阅都重新按名字挑，订阅刷新多了新节点自动进组。
*/

export const PROXY_SUB_GROUP_MATCHES = ["regex", "any", "all"] as const;
export type ProxySubGroupMatch = (typeof PROXY_SUB_GROUP_MATCHES)[number];

export const PROXY_SUB_GROUP_MATCH_LABELS: Record<ProxySubGroupMatch, { label: string; hint: string; placeholder: string }> = {
  regex: { label: "正则", hint: "整个表达式是一个正则（不分大小写），非法时按子串", placeholder: "正则，如 港|HK" },
  any: { label: "任一关键词", hint: "逗号分隔，含任一个就算；!词 排除，regex: 正则，=名 精确，&& 并且", placeholder: "关键词，如 香港, HK, !IPLC" },
  all: { label: "全部关键词", hint: "逗号分隔，全部都含才算；!词 排除，regex: 正则，=名 精确", placeholder: "关键词，如 香港, !IPLC" },
};

export function normalizeProxySubGroupMatch(value: unknown): ProxySubGroupMatch {
  const text = String(value ?? "").trim().toLowerCase();
  return (PROXY_SUB_GROUP_MATCHES as readonly string[]).includes(text) ? (text as ProxySubGroupMatch) : "regex";
}

type Term = { negate: boolean; test: (name: string) => boolean };

function compileAtom(raw: string): ((name: string) => boolean) | null {
  const atom = raw.trim();
  if (!atom) return null;
  if (/^regex:/i.test(atom)) {
    const source = atom.slice("regex:".length).trim();
    if (!source) return null;
    try {
      const regex = new RegExp(source, "i");
      return (name) => regex.test(name);
    } catch {
      const lower = source.toLowerCase();
      return (name) => name.toLowerCase().includes(lower);
    }
  }
  if (atom.startsWith("=")) {
    const exact = atom.slice(1).trim().toLowerCase();
    if (!exact) return null;
    return (name) => name.trim().toLowerCase() === exact;
  }
  const source = /^keyword:/i.test(atom) ? atom.slice("keyword:".length).trim() : atom;
  if (!source) return null;
  const lower = source.toLowerCase();
  return (name) => name.toLowerCase().includes(lower);
}

/**
 * 一个词：可能是 `a && b`（都要满足），可能带 `!`。
 * 整个词以 `!` 开头且没有 `&&` 时是排除条件（命中就踢出去）；`&&` 链里的 `!` 只是那一段取反。
 */
function compileTerm(raw: string): Term | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith("!") && !text.includes("&&")) {
    const atom = compileAtom(text.slice(1));
    return atom ? { negate: true, test: atom } : null;
  }
  const atoms = text.split("&&").map((piece) => {
    const part = piece.trim();
    const negated = part.startsWith("!");
    const atom = compileAtom(negated ? part.slice(1) : part);
    if (!atom) return null;
    return negated ? (name: string) => !atom(name) : atom;
  }).filter((item): item is (name: string) => boolean => !!item);
  if (atoms.length === 0) return null;
  return { negate: false, test: (name) => atoms.every((atom) => atom(name)) };
}

export function parseProxySubGroupTerms(filter: string): Term[] {
  return String(filter || "")
    .split(/[,，\n]/)
    .map(compileTerm)
    .filter((item): item is Term => !!item);
}

/** 语法检查：返回第一个问题（给保存前的校验用），没问题返回 null。 */
export function validateProxySubGroupFilter(filter: string, match: ProxySubGroupMatch): string | null {
  const text = String(filter || "").trim();
  if (!text) return null;
  if (match === "regex") return null;
  for (const raw of text.split(/[,，\n]/)) {
    const term = raw.trim();
    if (!term) continue;
    const body = term.startsWith("!") ? term.slice(1).trim() : term;
    if (!body) return "「!」后面要跟一个词";
    for (const atom of body.split("&&")) {
      const piece = atom.trim().replace(/^!\s*/, "");
      if (!piece) return "「&&」两边都要有词";
      if (/^regex:/i.test(piece)) {
        const source = piece.slice("regex:".length).trim();
        if (!source) return "「regex:」后面要跟正则";
        try {
          new RegExp(source, "i");
        } catch {
          return `正则「${source}」不合法`;
        }
      }
      if (piece.startsWith("=") && !piece.slice(1).trim()) return "「=」后面要跟节点名";
    }
  }
  return null;
}

export function compileProxySubGroupFilter(filter: string, match: ProxySubGroupMatch = "regex"): (name: string) => boolean {
  const text = String(filter || "").trim();
  if (!text) return () => true;
  if (match === "regex") {
    try {
      const regex = new RegExp(text, "i");
      return (name) => regex.test(name);
    } catch {
      const lower = text.toLowerCase();
      return (name) => name.toLowerCase().includes(lower);
    }
  }
  const terms = parseProxySubGroupTerms(text);
  const positive = terms.filter((term) => !term.negate);
  const negative = terms.filter((term) => term.negate);
  return (name) => {
    if (negative.some((term) => term.test(name))) return false;
    if (positive.length === 0) return true;
    return match === "all" ? positive.every((term) => term.test(name)) : positive.some((term) => term.test(name));
  };
}
