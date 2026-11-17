import test from "node:test";
import assert from "node:assert/strict";
import { firstEnabled, matching, MAX_SESSION_MATCHES, nextEnabled, orderedCommands, paletteRows, type PaletteCommand } from "../packages/client/src/command-palette.js";

const commands: PaletteCommand[] = [
  { id: "new-session", title: "New session", group: "Sessions", scope: "global" },
  { id: "rename", title: "Rename…", group: "Session", scope: "session", keywords: ["title"] },
  { id: "settings", title: "Settings", group: "Settings", scope: "global" },
  { id: "details", title: "Session details", group: "Panel", scope: "session" },
  { id: "archive", title: "Archive", group: "Session", scope: "session", disabled: "The session is busy" },
  { id: "switch", title: "Switch session…", group: "Sessions", scope: "global" },
];

test("with nothing typed, the session's commands come first, grouped in the order each group first appears, then the global ones", () => {
  assert.deepEqual(orderedCommands(commands).map(command => command.id), ["rename", "archive", "details", "new-session", "switch", "settings"]);
  assert.deepEqual(paletteRows("  ", commands, [{ id: "s1", title: "Settings page" }]).map(row => row.kind === "command" ? row.command.id : row.session.id),
    ["rename", "archive", "details", "new-session", "switch", "settings"]);
});

test("every typed word must appear, and a title that starts with the first word ranks before one with it at a word's start, then anywhere", () => {
  const items = ["Unarchive", "Archive", "Copy archive link", "Search archived"];
  assert.deepEqual(matching("arch", items, item => item), ["Archive", "Copy archive link", "Search archived", "Unarchive"]);
  assert.deepEqual(matching("arch link", items, item => item), ["Copy archive link"]);
  assert.deepEqual(matching("ARCH", items, item => item)[0], "Archive");
  assert.deepEqual(matching("", items, item => item), items);
});

test("typing lists the matching commands, by title, keyword or group, then the sessions whose title matches", () => {
  const rows = paletteRows("se", commands, [{ id: "s1", title: "Search the settings" }, { id: "s2", title: "Fix login" }]);
  assert.deepEqual(rows.map(row => row.kind === "command" ? row.command.id : `session:${row.session.id}`),
    ["details", "settings", "rename", "archive", "new-session", "switch", "session:s1"]);
  assert.deepEqual(paletteRows("title", commands, []).map(row => row.kind === "command" ? row.command.id : ""), ["rename"]);
  assert.deepEqual(paletteRows("login", commands, [{ id: "s2", title: "Fix login" }]), [{ kind: "session", session: { id: "s2", title: "Fix login" } }]);
});

test("sessions found by title are capped", () => {
  const sessions = Array.from({ length: MAX_SESSION_MATCHES + 5 }, (_, index) => ({ id: `s${index}`, title: `Flaky test ${index}` }));
  assert.equal(paletteRows("flaky", commands, sessions).length, MAX_SESSION_MATCHES);
});

test("the keys move past dimmed rows and around the ends", () => {
  const disabled = [true, false, true, false];
  assert.equal(firstEnabled(disabled), 1);
  assert.equal(nextEnabled(disabled, 1, 1), 3);
  assert.equal(nextEnabled(disabled, 3, 1), 1);
  assert.equal(nextEnabled(disabled, 1, -1), 3);
  assert.equal(nextEnabled([true, true], 0, 1), -1);
  assert.equal(nextEnabled([], 0, 1), -1);
  assert.equal(firstEnabled([true]), -1);
});
