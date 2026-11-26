import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { defaultHostConfig, readHostConfig } from "../packages/shared/src/host-config.js";

const migrations = new URL("../apps/server/migrations/sqlite/", import.meta.url);
const migration = "0097_tool_search_default.sql";

test("tool search is on for new hosts and for a control plane that sends no built-in extensions", () => {
  assert.deepEqual(defaultHostConfig.builtinExtensions, ["pi:tool-search"]);
  assert.deepEqual(readHostConfig({ commandTimeoutSeconds: 120, gpu: false, gitCredentials: false, repositoryCache: "off" }).builtinExtensions, ["pi:tool-search"]);
  assert.deepEqual(readHostConfig({ ...defaultHostConfig, builtinExtensions: [] }).builtinExtensions, [], "a host that turned it off keeps it off");
});

test("hosts configured before get tool search added to what they run, once, keeping code mode and its order", () => {
  const files = readdirSync(migrations).filter(name => name.endsWith(".sql")).sort();
  assert.ok(files.includes(migration));
  assert.ok(readdirSync(new URL("../apps/server/migrations/postgres/", import.meta.url)).includes("0090_tool_search_default.sql"), "Postgres has the same migration");
  const sqlite = new DatabaseSync(":memory:");
  for (const file of files.filter(name => name < migration)) sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  sqlite.exec("PRAGMA foreign_keys = OFF");
  for (const [id, json] of [["none", "[]"], ["codemode", "[\"pi:codemode\"]"], ["on", "[\"pi:codemode\",\"pi:tool-search\"]"], ["bare", "[\"tool-search\"]"], ["broken", "not json"]] as const) {
    sqlite.prepare("INSERT INTO connector_configs (connector_id, builtin_extensions_json, updated_at) VALUES (?, ?, ?)").run(id, json, "2026-01-01T00:00:00.000Z");
  }
  sqlite.exec(readFileSync(new URL(migration, migrations), "utf8"));
  const rows = Object.fromEntries(sqlite.prepare("SELECT connector_id, builtin_extensions_json FROM connector_configs").all().map(row => [row.connector_id, row.builtin_extensions_json]));
  assert.deepEqual(rows, {
    none: "[\"pi:tool-search\"]",
    codemode: "[\"pi:codemode\",\"pi:tool-search\"]",
    on: "[\"pi:codemode\",\"pi:tool-search\"]",
    bare: "[\"tool-search\"]",
    broken: "not json",
  });
});
