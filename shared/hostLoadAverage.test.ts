import assert from "node:assert/strict";
import test from "node:test";
import {
  formatHostLoadAverage,
  hasHostLoadAverage,
  hostLoadAverageTooltip,
  loadAverageFromStored,
  loadAverageToStored,
  parseAgentLoadAverage,
} from "./hostLoadAverage";

test("agent load average parses a three-number array and ignores anything else", () => {
  assert.deepEqual(parseAgentLoadAverage([0.12, 0.25, 0.384]), { load1: 0.12, load5: 0.25, load15: 0.38 });
  assert.deepEqual(parseAgentLoadAverage(undefined), { load1: null, load5: null, load15: null });
  assert.deepEqual(parseAgentLoadAverage([1, 2]), { load1: null, load5: null, load15: null });
  assert.deepEqual(parseAgentLoadAverage(["1", -1, Number.NaN]), { load1: null, load5: null, load15: null });
});

test("stored as integer hundredths and read back as decimals", () => {
  assert.equal(loadAverageToStored(0.12), 12);
  assert.equal(loadAverageToStored(3.456), 346);
  assert.equal(loadAverageToStored(null), null);
  assert.equal(loadAverageFromStored(12), 0.12);
  assert.equal(loadAverageFromStored("250"), 2.5);
  assert.equal(loadAverageFromStored(null), null);
  assert.equal(loadAverageFromStored(-5), null);
});

test("display only when all three values were reported", () => {
  assert.equal(formatHostLoadAverage({ load1: 0.12, load5: 0.25, load15: 0.38 }), "0.12 / 0.25 / 0.38");
  assert.equal(formatHostLoadAverage({ load1: 0, load5: 0, load15: 0 }), "0.00 / 0.00 / 0.00");
  assert.equal(formatHostLoadAverage({ load1: 0.1, load5: null, load15: 0.3 }), null);
  assert.equal(formatHostLoadAverage(null), null);
  assert.equal(hasHostLoadAverage({}), false);
  assert.equal(hostLoadAverageTooltip({ load1: 1, load5: 2, load15: 3 }), "负载（1 / 5 / 15 分钟）：1.00 / 2.00 / 3.00");
});
