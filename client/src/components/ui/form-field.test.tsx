import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FormField } from "./form-field";
import { Label } from "./label";
import { Input } from "./input";
import { Textarea } from "./textarea";
import { Select, SelectTrigger, SelectValue } from "./select";
import { Switch } from "./switch";
import DatePickerInput from "@/components/DatePickerInput";

test("repeated fields each connect their label to their own control", () => {
  const html = renderToStaticMarkup(<>
    {[0, 1].map(index => <FormField key={index}><Label>目标地址</Label><Input /></FormField>)}
    <FormField><Label>备注</Label><Textarea /></FormField>
    <FormField><Label>线路</Label><Select><SelectTrigger><SelectValue placeholder="选择线路" /></SelectTrigger></Select></FormField>
  </>);
  const labels = [...html.matchAll(/<label[^>]* for="([^"]+)"/g)].map(match => match[1]);
  const controls = [...html.matchAll(/<(?:input|textarea|button)[^>]* id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(labels.length, 4);
  assert.equal(new Set(labels).size, 4);
  assert.deepEqual(controls, labels);
});

test("explicit ids and labels keep their association", () => {
  const html = renderToStaticMarkup(<FormField><Label htmlFor="existing-port">端口</Label><Input id="existing-port" aria-describedby="port-help" /></FormField>);
  assert.match(html, /for="existing-port"/);
  assert.match(html, /id="existing-port"/);
  assert.match(html, /aria-describedby="port-help"/);
});

test("standalone controls do not inherit an unrelated field id", () => {
  const html = renderToStaticMarkup(<><FormField><Label>地址</Label><Input /></FormField><Input aria-label="搜索" /></>);
  assert.equal([...html.matchAll(/<input[^>]* id="/g)].length, 1);
  assert.match(html, /aria-label="搜索"/);
});

/*
  开关也要接进来。Radix 渲染出来是 <button role="switch">，而 <label for> 对 button
  同样有效 —— 实测 Chrome 给出的名称来源就是 labelfor。接上之后就不用把界面上那句话
  在 aria-label 里再抄一遍。
*/
test("switches in a field connect to their label", () => {
  const html = renderToStaticMarkup(<FormField><Label>转发总开关</Label><Switch checked={false} /></FormField>);
  const [, labelFor] = html.match(/<label[^>]* for="([^"]+)"/) ?? [];
  const [, buttonId] = html.match(/<button[^>]* id="([^"]+)"/) ?? [];
  assert.ok(labelFor, "label 没有 for");
  assert.equal(buttonId, labelFor);
});

test("a switch outside a field keeps its own name", () => {
  const html = renderToStaticMarkup(<Switch aria-label="站点维护模式" checked={false} />);
  assert.equal([...html.matchAll(/<button[^>]* id="/g)].length, 0);
  assert.match(html, /aria-label="站点维护模式"/);
});

/*
  日期选择器也是 <button> 触发的，和开关一样靠 <label for> 命名。
  以前它不接 FormField 的 id，Billing / Hosts 的「生效日期」「机器购买时间」这些 Label 一直悬空。
*/
test("date pickers in a field connect to their label", () => {
  const html = renderToStaticMarkup(<>
    <FormField><Label>生效日期</Label><DatePickerInput value="" onChange={() => {}} placeholder="立即生效" /></FormField>
    <FormField><Label>失效日期</Label><DatePickerInput value="2026-01-02" onChange={() => {}} /></FormField>
  </>);
  const labels = [...html.matchAll(/<label[^>]* for="([^"]+)"/g)].map(match => match[1]);
  const triggers = [...html.matchAll(/<button[^>]* id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(labels.length, 2);
  assert.equal(new Set(labels).size, 2);
  assert.deepEqual(triggers, labels);
});

test("a date picker outside a field keeps an explicit id and no stray one", () => {
  const loose = renderToStaticMarkup(<DatePickerInput value="" onChange={() => {}} />);
  assert.equal([...loose.matchAll(/<button[^>]* id="/g)].length, 0);
  const explicit = renderToStaticMarkup(<FormField><Label htmlFor="expires">到期</Label><DatePickerInput id="expires" value="" onChange={() => {}} /></FormField>);
  assert.match(explicit, /for="expires"/);
  assert.match(explicit, /<button[^>]* id="expires"/);
});
