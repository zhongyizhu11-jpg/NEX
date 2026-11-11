import assert from "node:assert/strict";
import test from "node:test";
import {
  browserLanguage,
  formatLocaleFor,
  LANGUAGE_STORAGE_KEY,
  parseLanguagePreference,
  readLanguagePreference,
  resolveLanguage,
  writeLanguagePreference,
} from "./language";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

test("偏好只认 auto / zh-CN / en，其它一律当 auto", () => {
  assert.equal(parseLanguagePreference("en"), "en");
  assert.equal(parseLanguagePreference("zh-CN"), "zh-CN");
  assert.equal(parseLanguagePreference("zh"), "auto");
  assert.equal(parseLanguagePreference(null), "auto");
  assert.equal(parseLanguagePreference("EN"), "auto");
});

test("auto 跟浏览器语言：先出现哪种算哪种，都没有默认中文", () => {
  assert.equal(browserLanguage(["en-US", "zh-CN"]), "en");
  assert.equal(browserLanguage(["fr-FR", "zh-TW", "en"]), "zh-CN");
  assert.equal(browserLanguage(["fr-FR"]), null);
  assert.equal(resolveLanguage("auto", ["en-GB"]), "en");
  assert.equal(resolveLanguage("auto", ["de-DE"]), "zh-CN");
  assert.equal(resolveLanguage("auto", []), "zh-CN");
  assert.equal(resolveLanguage("zh-CN", ["en-US"]), "zh-CN");
  assert.equal(resolveLanguage("en", ["zh-CN"]), "en");
  assert.equal(formatLocaleFor("en"), "en-US");
  assert.equal(formatLocaleFor("zh-CN"), "zh-CN");
});

test("偏好存进 localStorage，auto 就删掉这一项；存储坏了不抛", () => {
  const storage = memoryStorage();
  assert.equal(readLanguagePreference(storage), "auto");
  assert.equal(writeLanguagePreference("en", storage), true);
  assert.equal(storage.values.get(LANGUAGE_STORAGE_KEY), "en");
  assert.equal(readLanguagePreference(storage), "en");
  assert.equal(writeLanguagePreference("zh-CN", storage), true);
  assert.equal(readLanguagePreference(storage), "zh-CN");
  assert.equal(writeLanguagePreference("auto", storage), true);
  assert.equal(storage.values.has(LANGUAGE_STORAGE_KEY), false);
  assert.equal(readLanguagePreference(storage), "auto");

  const broken = {
    getItem: () => { throw new Error("SecurityError"); },
    setItem: () => { throw new Error("QuotaExceededError"); },
    removeItem: () => { throw new Error("SecurityError"); },
  };
  assert.equal(readLanguagePreference(broken), "auto");
  assert.equal(writeLanguagePreference("en", broken), false);
  assert.equal(writeLanguagePreference("en", null), false);
});
