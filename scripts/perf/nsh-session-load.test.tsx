// Measures how long the NSH desktop client takes to open a session: from a click on its row in the sidebar to its
// transcript on screen, on NSH's own engine (headless, as `nsh test` runs it) against a stubbed server.
//
//   node scripts/nsh.mjs test ../../scripts/perf/nsh-session-load.test.tsx      # from the repository root
//
// It lives outside apps/nsh, with an App.tsx and nsh.json of its own that mount the client, so `pnpm test:client` doesn't
// run it. Add `--target linux` (or macos, windows) on a desktop
// to time it in a real window, with native drawing.
//
// Each case prints one `PERF {...}` line. Network delays are real (wall clock), so the totals are what a person waits
// for minus native drawing, which the headless engine doesn't do.
import { describe, open, test } from "nsh/test";
import { ORIGIN, server, sessionRecord, signedIn, view } from "../../apps/nsh/tests/fixtures";

type Request = { method: string; url: string };

/** A transcript of `count` entries, in turns as an agent writes them: a message, tool calls, their output, a reply. */
function transcript(count: number) {
  const entries: Record<string, unknown>[] = [];
  const output = Array.from({ length: 40 }, (_, line) => `src/module-${line}.ts:${line + 1}:  export function step${line}(input: string) { return input.trim(); }`).join("\n");
  for (let turn = 0; entries.length < count; turn++) {
    const turnEntries = [
      { id: `t${turn}-u`, kind: "message", role: "user", text: `Turn ${turn}: why does the login test fail on CI? marker-${turn}`, actorId: "u1", conversationId: "0" },
      { id: `t${turn}-a`, kind: "message", role: "assistant", conversationId: "0", durationMs: 2100,
        text: `I'll look at the test and the code it covers.\n\nread({"path":"tests/login-${turn}.test.ts","offset":1,"limit":120})\nbash({"command":"pnpm test -- --filter login-${turn}"})` },
      { id: `t${turn}-r1`, kind: "message", role: "toolResult", text: output, conversationId: "0", durationMs: 40 },
      { id: `t${turn}-r2`, kind: "message", role: "toolResult", text: `FAIL tests/login-${turn}.test.ts\n${output}`, conversationId: "0", durationMs: 5300 },
      { id: `t${turn}-f`, kind: "message", role: "assistant", conversationId: "0", durationMs: 6400,
        text: `The test **races** the session cookie.\n\n- It reads \`/api/me\` too early\n- Fix: wait for the redirect\n\n\`\`\`ts\nawait page.waitForURL("/app");\nconst me = await request.get("/api/me");\nexpect(me.ok()).toBe(true);\n\`\`\`\n\nDone in turn ${turn}.` },
    ];
    entries.push(...turnEntries.slice(0, count - entries.length));
  }
  return entries;
}

interface Case { entries: number; metaMs?: number; viewMs?: number; listMs?: number }

async function measure(name: string, { entries: count, metaMs = 0, viewMs = 0, listMs = 0 }: Case) {
  const entries = transcript(count);
  const last = entries.filter(entry => entry.role === "user").at(-1)!.text as string;
  const big = { ...view, entries, approvals: [], busy: false, queue: [], activity: "idle" };
  const payload = JSON.stringify({ view: big, revision: "r1" });
  // When each request reaches the server, relative to the click.
  let clicked = 0;
  const arrivals: string[] = [];
  const at = (label: string) => arrivals.push(`${label}@${clicked ? Date.now() - clicked : "pre"}`);
  const app = await open("App.tsx", {
    platform: "linux", width: 1280, height: 800, storage: signedIn,
    network: server({
      [`GET ${ORIGIN}/api/sessions`]: (_request: Request) => {
        at("list");
        return { body: { sessions: [sessionRecord, { ...sessionRecord, id: "s3", title: "Add a dark mode" }] }, delay: listMs };
      },
      [`GET ${ORIGIN}/api/sessions/s1`]: (_request: Request) => { at("meta"); return { body: { session: sessionRecord }, delay: metaMs }; },
      [`GET ${ORIGIN}/api/sessions/s1/view`]: (_request: Request) => {
        at("view");
        return { headers: { "content-type": "application/json" }, body: payload, delay: viewMs };
      },
      [`GET ${ORIGIN}/api/sessions/s1/events*`]: (_request: Request) => {
        at("events");
        // A quiet session's stream sends nothing while it is open, as the server's does when the client is up to date.
        return { status: 200, headers: { "content-type": "text/event-stream" }, body: "", delay: 600_000 };
      },
    }),
  });
  await app.waitFor("id:session-row-s1", { timeout: 20_000 });
  arrivals.length = 0;
  clicked = Date.now();
  await app.press("id:session-row-s1");
  const pressed = Date.now() - clicked;
  await app.waitFor("id:composer-input", { timeout: 60_000 });
  const composer = Date.now() - clicked;
  await app.waitFor(`text:${last}`, { timeout: 60_000 });
  const shown = Date.now() - clicked;
  const waterfall = arrivals.join(" ");
  // Opening it again (another session, then back): the client keeps nothing, so it loads it all again.
  await app.press("id:session-row-s3");
  await app.waitFor("id:composer-input", { timeout: 20_000 });
  const again = Date.now();
  await app.press("id:session-row-s1");
  await app.waitFor(`text:${last}`, { timeout: 60_000 });
  const reopened = Date.now() - again;
  console.log(`PERF ${JSON.stringify({ name, entries: count, viewKB: Math.round(payload.length / 1024), metaMs, viewMs,
    pressMs: pressed, composerMs: composer, transcriptMs: shown, reopenMs: reopened, waterfall })}`);
}

describe("session load", () => {
  // The client's own cost: no network delay at all, so what is left is parsing, the live session and rendering.
  for (const entries of [10, 100, 500, 1000, 2000]) {
    test(`client only, ${entries} entries`, () => measure("client", { entries }), 120_000);
  }
  // Production-like: pikibun.com answers an API request in about 170 ms (measured), and /view adds the server's round
  // trip to the host through its connector plus moving the whole view from the host to the server and on to the app.
  const cases: [number, number][] = [[100, 400], [500, 800], [1000, 1500]];
  for (const [entries, viewMs] of cases) {
    test(`with latency, ${entries} entries`, () => measure("latency", { entries, metaMs: 170, viewMs }), 120_000);
  }
});
