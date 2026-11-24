import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { commandSeconds, defaultHostConfig, hostConfigLimits, parseHostConfig, parseHostConfigChange, readHostConfig, unlimitedCommandSeconds } from "../packages/shared/src/host-config.js";
import { callLimits, callTimeout, commandLimits, configuredLimits } from "../apps/runner/src/host-config.js";
import { resourceLaunch } from "../apps/runner/src/resources.js";

const migrations = new URL("../apps/server/migrations/sqlite/", import.meta.url);
const migration = "0087_command_time_limit.sql";

test("a host's command time limit starts at an hour, and No limit lifts it while keeping the seconds older connectors apply", () => {
  assert.equal(defaultHostConfig.commandTimeoutSeconds, 3600);
  assert.equal(defaultHostConfig.commandTimeoutSeconds, hostConfigLimits.commandTimeoutSeconds.max);
  assert.equal(defaultHostConfig.commandTimeoutUnlimited, false);
  assert.equal(commandSeconds(defaultHostConfig), 3600);
  assert.equal(commandSeconds({ commandTimeoutSeconds: 600, commandTimeoutUnlimited: true }), unlimitedCommandSeconds);
  assert.deepEqual(parseHostConfigChange({ commandTimeoutUnlimited: true }), { commandTimeoutUnlimited: true });
  assert.throws(() => parseHostConfig({ ...defaultHostConfig, commandTimeoutUnlimited: 1 }), /Invalid command time limit setting/);
  assert.throws(() => parseHostConfig({ ...defaultHostConfig, commandTimeoutSeconds: unlimitedCommandSeconds }), /between 30 and 3600 seconds/, "No limit is its own setting, never a number of seconds");
  const fromBefore = readHostConfig({ commandTimeoutSeconds: 120, gpu: false, gitCredentials: false, repositoryCache: "off" });
  assert.deepEqual([fromBefore.commandTimeoutSeconds, fromBefore.commandTimeoutUnlimited], [120, false], "a server from before No limit sends none");
  assert.equal(readHostConfig({ commandTimeoutSeconds: 120, commandTimeoutUnlimited: true }).commandTimeoutUnlimited, true);
});

test("without a limit a command gets the room of a long one, a timer Node.js takes, and a deadline the resource supervisor takes", () => {
  const limited = configuredLimits({ commandTimeoutSeconds: 600, commandTimeoutUnlimited: false }, 2);
  assert.deepEqual(limited, commandLimits(600, 2));
  const unlimited = configuredLimits({ commandTimeoutSeconds: 600, commandTimeoutUnlimited: true }, 2);
  assert.deepEqual(unlimited, { seconds: unlimitedCommandSeconds, cpuSeconds: unlimitedCommandSeconds * 2, fileBytes: limited.fileBytes, openFiles: limited.openFiles });
  assert.ok(unlimited.seconds * 1000 < 2 ** 31, "setTimeout would fire at once past 2^31 milliseconds");
  assert.equal(commandLimits(99_999, 2).seconds, 3600, "any other number of seconds is still held to an hour");
  assert.equal(callLimits(unlimited, 90).seconds, 90, "the call's own timeout still ends it sooner");
  assert.equal(callLimits(unlimited).seconds, unlimitedCommandSeconds);
  assert.throws(() => callTimeout(3601), /from 1 to 3600/);
  const resources = { root: "/sys/fs/cgroup/pikibun", cpus: 2, memoryBytes: 2 ** 30, pids: 256 };
  let launched: { command: string; args: string[] } | undefined;
  try { launched = resourceLaunch(resources as never, "a".repeat(64), ["true"], unlimited.seconds); }
  catch (error) { assert.doesNotMatch(String(error), /Invalid resource deadline/); }
  if (launched) {
    assert.ok(launched.args.includes(String(unlimitedCommandSeconds)));
    assert.ok(launched.args.some(arg => arg.includes(`int(sys.argv[4]) <= ${unlimitedCommandSeconds}`)), "the supervisor takes the same longest deadline");
  }
  assert.throws(() => resourceLaunch(resources as never, "a".repeat(64), ["true"], unlimitedCommandSeconds + 1), /Invalid resource deadline/);
});

test("hosts whose saved limit was the old 30-second default get the hour; chosen limits stay, and nothing is unlimited until chosen", () => {
  const files = readdirSync(migrations).filter(name => name.endsWith(".sql")).sort();
  assert.ok(files.includes(migration));
  assert.ok(readdirSync(new URL("../apps/server/migrations/postgres/", import.meta.url)).includes("0080_command_time_limit.sql"), "Postgres has the same migration");
  const sqlite = new DatabaseSync(":memory:");
  for (const file of files.filter(name => name < migration)) sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  sqlite.exec("PRAGMA foreign_keys = OFF");
  for (const [id, seconds] of [["default", 30], ["chosen", 600], ["hour", 3600]] as const) {
    sqlite.prepare("INSERT INTO connector_configs (connector_id, command_timeout_seconds, updated_at) VALUES (?, ?, ?)").run(id, seconds, "2026-01-01T00:00:00.000Z");
  }
  sqlite.exec(readFileSync(new URL(migration, migrations), "utf8"));
  const rows = sqlite.prepare("SELECT connector_id, command_timeout_seconds, command_timeout_unlimited FROM connector_configs ORDER BY connector_id").all().map(row => ({ ...row }));
  assert.deepEqual(rows, [
    { connector_id: "chosen", command_timeout_seconds: 600, command_timeout_unlimited: 0 },
    { connector_id: "default", command_timeout_seconds: 3600, command_timeout_unlimited: 0 },
    { connector_id: "hour", command_timeout_seconds: 3600, command_timeout_unlimited: 0 },
  ]);
  assert.throws(() => sqlite.prepare("UPDATE connector_configs SET command_timeout_unlimited = 2 WHERE connector_id = 'chosen'").run(), /CHECK constraint failed/);
});
