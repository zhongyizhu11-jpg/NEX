import { useCallback } from "react";
import { toast } from "sonner";
import { clipboardNeedsManualCopy, copyTextFromElement, copyTextToClipboard } from "@/lib/clipboard";

/**
 * 「复制 + 弹 toast」只写一份。
 *
 * 之前 API 令牌、商城对接、Agent Token 三处各抄了一个 `copy(text, what)`：成功文案不一样、
 * http 下的失败提示却是逐字相同的一句 —— 改一处漏两处。这里把它收成一个 hook，调用方只管
 * 说「复制成功提示什么」。
 *
 * 给了 `element` 时走 copyTextFromElement：选中的是屏幕上那段真文字，失败时选区还留着，
 * 用户直接用系统菜单复制就行，所以失败文案也跟着换。
 */
export function useCopyWithToast() {
  return useCallback(async (text: string, options?: { success?: string; element?: HTMLElement | null }) => {
    const ok = options?.element ? await copyTextFromElement(options.element, text) : await copyTextToClipboard(text);
    if (ok) {
      toast.success(options?.success || "已复制");
      return true;
    }
    if (options?.element) {
      toast.error("浏览器拒绝了复制，内容已选中，用系统菜单复制即可");
    } else {
      toast.error(clipboardNeedsManualCopy() ? "当前是 http 访问，浏览器限制了剪贴板，请长按选中内容复制" : "复制失败，请手动复制");
    }
    return false;
  }, []);
}
