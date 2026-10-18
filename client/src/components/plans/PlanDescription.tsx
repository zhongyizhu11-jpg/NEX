import { useMemo, useState } from "react";
import { ChevronDown, Eye, FileText } from "lucide-react";
import { PLAN_DESCRIPTION_MAX_LENGTH, PLAN_DESCRIPTION_TEMPLATE } from "@shared/planDescription";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { describeContentFormat, looksLikeHtml, looksLikeMarkdown, renderMixedHtml } from "@/lib/htmlContent";

/** 说明是不是写了排版（Markdown / HTML）。纯文本照旧按一段灰字显示。 */
export function isRichPlanDescription(text: string) {
  return looksLikeHtml(text) || looksLikeMarkdown(text);
}

/**
 * 商店卡片上的套餐说明（上游 2.3.285 支持富文本）。
 *
 * 纯文本：和原来一样，最多三行灰字。
 * 有排版的：按 Markdown / 过滤后的 HTML 渲染，先收在 7rem 高、底部淡出，
 * 「展开说明」后全部显示 —— 不然一段长介绍会把价格和购买按钮挤到屏幕外。
 */
export function PlanDescriptionView({ text, fallback }: { text: string; fallback: string }) {
  const [expanded, setExpanded] = useState(false);
  const value = text.trim();
  const rich = !!value && isRichPlanDescription(value);
  const html = useMemo(() => (rich ? renderMixedHtml(value) : ""), [rich, value]);
  if (!rich) {
    return <div className="mt-1 line-clamp-3 text-secondary-type text-muted-foreground">{value || fallback}</div>;
  }
  return (
    <div className="mt-1 min-w-0">
      <div
        className={`fx-rich-text relative min-w-0 overflow-hidden text-secondary-type text-muted-foreground ${expanded ? "" : "max-h-28 [mask-image:linear-gradient(to_bottom,black_60%,transparent)]"}`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <button
        type="button"
        className="mt-1 inline-flex items-center gap-1 text-meta text-muted-foreground hover:text-foreground"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        {expanded ? "收起说明" : "展开说明"}
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
    </div>
  );
}

/** 套餐编辑框里的说明：字数、预览、插入模板。 */
export function PlanDescriptionEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [preview, setPreview] = useState(false);
  const format = value.trim() ? describeContentFormat(value) : null;
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="plan-description">说明</Label>
        <div className="flex items-center gap-1">
          {!value.trim() ? (
            <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 px-2" onClick={() => onChange(PLAN_DESCRIPTION_TEMPLATE)}>
              <FileText className="h-3.5 w-3.5" aria-hidden="true" />插入模板
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 px-2" aria-expanded={preview} aria-controls="plan-description-preview" onClick={() => setPreview((open) => !open)}>
            <Eye className="h-3.5 w-3.5" aria-hidden="true" />{preview ? "收起预览" : "预览"}
          </Button>
        </div>
      </div>
      <Textarea
        id="plan-description"
        className="min-h-32 font-mono text-xs leading-6"
        value={value}
        maxLength={PLAN_DESCRIPTION_MAX_LENGTH}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby="plan-description-help"
        placeholder="展示给用户看的套餐说明"
      />
      <div className="flex flex-wrap items-start justify-between gap-2 text-xs text-muted-foreground">
        <p id="plan-description-help" className="min-w-0 flex-1 basis-56">
          支持 Markdown 和 HTML 排版，脚本等危险内容会被过滤。说明只是展示，不改变实际权益和价格。{format ? `当前按 ${format} 显示。` : ""}
        </p>
        <span className="shrink-0 tabular-nums">{value.length} / {PLAN_DESCRIPTION_MAX_LENGTH}</span>
      </div>
      {preview ? (
        <div id="plan-description-preview" className="min-w-0 rounded-lg border bg-background/50 p-3">
          {value.trim()
            ? <div className="fx-rich-text min-w-0 text-secondary-type text-muted-foreground" dangerouslySetInnerHTML={{ __html: renderMixedHtml(value) }} />
            : <p className="text-sm text-muted-foreground">说明为空，商店里显示默认的一句介绍。</p>}
        </div>
      ) : null}
    </div>
  );
}
