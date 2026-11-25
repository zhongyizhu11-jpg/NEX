import assert from "node:assert/strict";
import test from "node:test";
import { inferConfirmTone } from "./confirm-dialog";

/**
 * 确认框的语气不用每处都写：按钮上的字含「删除 / 移除 / 清空 / 重置」就按破坏性画（红按钮、手机操作表红字），
 * 明确传了 tone 听传的。「确认升级」「仍然复制」这种不算。
 */
test("按 confirmText 推断语气：删除 / 移除 / 清空 / 重置算破坏性，其余默认", () => {
  for (const text of ["删除", "确认删除", "确认移除", "清空日志", "确认重置", "放弃修改并删除"]) {
    assert.equal(inferConfirmTone(text), "destructive", text);
  }
  for (const text of ["确认", "确认升级", "仍然复制", "关闭并保存", "放弃修改", "保存"]) {
    assert.equal(inferConfirmTone(text), "default", text);
  }
});

test("明确传了 tone 就听传的，不再按字猜", () => {
  assert.equal(inferConfirmTone("确认删除", "default"), "default");
  assert.equal(inferConfirmTone("确认取消", "destructive"), "destructive");
});
