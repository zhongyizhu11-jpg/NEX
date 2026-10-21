import assert from "node:assert/strict";
import test from "node:test";

import { normalizePersonalizationLayout, normalizeUserLayoutPreference, resolveEffectiveLayout } from "./personalization";

/*
  布局密度谁说了算（shared/personalization.ts）：个人偏好 › 站点默认。
*/
test("站点默认：standard / compact，别的值回到 standard", () => {
  assert.equal(normalizePersonalizationLayout("compact"), "compact");
  assert.equal(normalizePersonalizationLayout("standard"), "standard");
  assert.equal(normalizePersonalizationLayout(""), "standard");
  assert.equal(normalizePersonalizationLayout("dense"), "standard");
  assert.equal(normalizePersonalizationLayout(undefined), "standard");
});

test("个人偏好：null 是跟随站点，不是 standard", () => {
  assert.equal(normalizeUserLayoutPreference(null), null);
  assert.equal(normalizeUserLayoutPreference(""), null);
  assert.equal(normalizeUserLayoutPreference("standard"), "standard");
  assert.equal(normalizeUserLayoutPreference("compact"), "compact");
});

test("个人偏好盖过站点默认；没选过就跟站点", () => {
  assert.equal(resolveEffectiveLayout({ uiLayout: "standard" }, "compact"), "standard");
  assert.equal(resolveEffectiveLayout({ uiLayout: "compact" }, "standard"), "compact");
  assert.equal(resolveEffectiveLayout({ uiLayout: null }, "compact"), "compact");
  assert.equal(resolveEffectiveLayout(null, "compact"), "compact");
  assert.equal(resolveEffectiveLayout(undefined, "standard"), "standard");
});
