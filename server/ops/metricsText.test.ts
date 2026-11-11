import assert from "node:assert/strict";
import test from "node:test";
import {
  escapeMetricHelp,
  escapeMetricLabelValue,
  formatMetricValue,
  METRIC_LABEL_VALUE_MAX_CHARS,
  renderMetricFamilies,
  type MetricFamily,
} from "./metricsText";

test("标签值里的反斜杠、双引号、换行按 Prometheus 文本格式转义，别的字符原样", () => {
  assert.equal(escapeMetricLabelValue('a\\b"c\nd'), 'a\\\\b\\"c\\nd');
  assert.equal(escapeMetricLabelValue("香港-01 {entry} = 100%"), "香港-01 {entry} = 100%");
  assert.equal(escapeMetricLabelValue(null), "");
  assert.equal(escapeMetricLabelValue(42), "42");
});

test("超长的标签值截断并以省略号结尾，截断发生在转义之前（不会把转义序列切成两半）", () => {
  const long = `${"名".repeat(METRIC_LABEL_VALUE_MAX_CHARS)}"尾巴`;
  const escaped = escapeMetricLabelValue(long);
  assert.equal(escaped.length, METRIC_LABEL_VALUE_MAX_CHARS);
  assert.ok(escaped.endsWith("…"));
  const quotes = `${"\"".repeat(METRIC_LABEL_VALUE_MAX_CHARS + 10)}`;
  // 每个引号转义成两个字符，结尾不会剩下落单的反斜杠
  assert.match(escapeMetricLabelValue(quotes), /^(\\")+…$/);
});

test("HELP 只转义反斜杠和换行，双引号原样", () => {
  assert.equal(escapeMetricHelp('说明 "引号" \\ 第二行\n完'), '说明 "引号" \\\\ 第二行\\n完');
});

test("值：整数和小数原样，非有限值写成 NaN / +Inf / -Inf，负零写成 0", () => {
  assert.equal(formatMetricValue(0), "0");
  assert.equal(formatMetricValue(-0), "0");
  assert.equal(formatMetricValue(1.5), "1.5");
  assert.equal(formatMetricValue(9007199254740991), "9007199254740991");
  assert.equal(formatMetricValue(Number.NaN), "NaN");
  assert.equal(formatMetricValue(Number.POSITIVE_INFINITY), "+Inf");
  assert.equal(formatMetricValue(Number.NEGATIVE_INFINITY), "-Inf");
});

test("每个指标族先 HELP 再 TYPE 再样本，整份以换行结尾", () => {
  const families: MetricFamily[] = [
    { name: "nex_hosts", help: "主机总数", type: "gauge", samples: [{ value: 3 }] },
    {
      name: "nex_host_traffic_bytes_total",
      help: "主机累计流量",
      type: "counter",
      samples: [
        { labels: { host_id: 1, host: 'HK "入口"\n01', direction: "in" }, value: 1024 },
        { labels: { host_id: 1, host: 'HK "入口"\n01', direction: "out" }, value: 2048 },
      ],
    },
  ];
  assert.equal(renderMetricFamilies(families), [
    "# HELP nex_hosts 主机总数",
    "# TYPE nex_hosts gauge",
    "nex_hosts 3",
    "# HELP nex_host_traffic_bytes_total 主机累计流量",
    "# TYPE nex_host_traffic_bytes_total counter",
    'nex_host_traffic_bytes_total{host_id="1",host="HK \\"入口\\"\\n01",direction="in"} 1024',
    'nex_host_traffic_bytes_total{host_id="1",host="HK \\"入口\\"\\n01",direction="out"} 2048',
    "",
  ].join("\n"));
});

test("没有样本的族整个不写；值是 NaN 的样本跳过；标签值为空（null / undefined）的标签不写", () => {
  const text = renderMetricFamilies([
    { name: "nex_empty", help: "空", type: "gauge", samples: [] },
    { name: "nex_unknown", help: "不知道", type: "gauge", samples: [{ value: Number.NaN }] },
    { name: "nex_some", help: "有", type: "gauge", samples: [{ labels: { a: "x", b: null, c: undefined }, value: 1 }] },
  ]);
  assert.equal(text, '# HELP nex_some 有\n# TYPE nex_some gauge\nnex_some{a="x"} 1\n');
  assert.equal(renderMetricFamilies([]), "");
});

test("同一个族里标签完全相同的两行只留第一行（否则 Prometheus 拒收整份）", () => {
  const text = renderMetricFamilies([{
    name: "nex_dup",
    help: "重复",
    type: "gauge",
    samples: [{ labels: { k: "v" }, value: 1 }, { labels: { k: "v" }, value: 2 }, { labels: { k: "w" }, value: 3 }],
  }]);
  assert.deepEqual(text.trim().split("\n").slice(2), ['nex_dup{k="v"} 1', 'nex_dup{k="w"} 3']);
});

test("指标名、标签名不合法，或同名的族出现两次，直接抛（这是写代码的人的错）", () => {
  assert.throws(() => renderMetricFamilies([{ name: "nex-bad", help: "", type: "gauge", samples: [{ value: 1 }] }]), /指标名不合法/);
  assert.throws(() => renderMetricFamilies([{ name: "nex_ok", help: "", type: "gauge", samples: [{ labels: { "bad-label": "x" }, value: 1 }] }]), /标签名不合法/);
  assert.throws(() => renderMetricFamilies([{ name: "nex_ok", help: "", type: "gauge", samples: [{ labels: { __reserved: "x" }, value: 1 }] }]), /标签名不合法/);
  const one: MetricFamily = { name: "nex_twice", help: "", type: "gauge", samples: [{ value: 1 }] };
  assert.throws(() => renderMetricFamilies([one, { ...one }]), /指标族重复/);
});
