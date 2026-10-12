import assert from "node:assert/strict";
import test from "node:test";

import { MIGRATION_TABLES } from "../dbSchema";
import { OPS_MIGRATION_TABLES } from "./opsTables";

test("运维功能要迁移的表都在 MIGRATION_TABLES 里", () => {
  for (const table of OPS_MIGRATION_TABLES) {
    assert.ok((MIGRATION_TABLES as readonly string[]).includes(table), `${table} 没进 MIGRATION_TABLES`);
  }
});
