import fs from "node:fs";
import path from "node:path";

/**
 * 规则页正在渐进拆分：RulesContent 里的一段段逻辑陆续搬到 client/src/features/rules/use*.ts(x) 这些 hook 里。
 * 靠读源码断言行为的测试用这个把页面和这些 hook 拼成一份看，搬动代码不用改测试。
 * @public
 */
export function readRulesPageSource(): string {
  const root = path.resolve(import.meta.dirname, "..");
  const page = fs.readFileSync(path.join(root, "pages/Rules.tsx"), "utf8");
  const hooksDir = path.join(root, "features/rules");
  // 批量管理弹窗的 JSX 也搬到了这个目录（RuleBatchManageDialog.tsx），和 hook 一起算页面的一部分
  const hooks = fs.readdirSync(hooksDir)
    .filter((name) => (/^use[A-Z].*\.tsx?$/.test(name) || name === "RuleBatchManageDialog.tsx") && !name.includes(".test."))
    .sort()
    .map((name) => fs.readFileSync(path.join(hooksDir, name), "utf8"));
  return [page, ...hooks].join("\n");
}
