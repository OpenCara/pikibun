import test from "node:test";
import assert from "node:assert/strict";
import { resolveObjectURL } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error: a plain .mjs build script
import { BEFORE_BOOTSTRAP, EARLY_MAP, LATE_MAP, fixWebSite } from "../scripts/nsh-web-fixes.mjs";

// Native Shell 0.4's site, reduced to what the fix reads: the runtime around its two spots, its loader and the page.
async function site(t: test.TestContext, runtime = `async run(e){try{${BEFORE_BOOTSTRAP}let O=1;${LATE_MAP}}catch{}}`) {
  const root = await mkdtemp(join(tmpdir(), "nsh-site-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "browser.991ab24c49"));
  await writeFile(join(root, "browser.991ab24c49", "runtime.js"), runtime);
  await writeFile(join(root, "browser.991ab24c49", "realm.js"), "realm");
  await writeFile(join(root, "nsh.89070fe10a.js"), "import(`./browser.991ab24c49/runtime.js`)");
  await writeFile(join(root, "nsh.89070fe10a.js.br"), "stale");
  await writeFile(join(root, "index.html"), `<script type="module">import { createPlayer } from "./nsh.89070fe10a.js";</script>`);
  return root;
}

test("the import map goes in before the bootstrap, in a renamed runtime and loader", async t => {
  const root = await site(t);
  const { runtime, loader } = fixWebSite(root);
  const names = await readdir(root);
  assert.ok(!names.includes("browser.991ab24c49") && !names.includes("nsh.89070fe10a.js") && !names.includes("nsh.89070fe10a.js.br"));
  assert.match(loader, /^nsh\.[0-9a-f]{10}\.js$/);
  assert.ok(existsSync(join(root, `${loader}.br`)) && existsSync(join(root, `${loader}.gz`)));
  assert.equal(await readFile(join(root, "index.html"), "utf8"), `<script type="module">import { createPlayer } from "./${loader}";</script>`);
  assert.equal(await readFile(join(root, loader), "utf8"), `import(\`./${runtime}\`)`);
  assert.equal(await readFile(join(root, runtime.replace("runtime.js", "realm.js")), "utf8"), "realm");
  const patched = await readFile(join(root, runtime), "utf8");
  assert.ok(patched.indexOf("__nshEarlyMap=Object.assign") < patched.indexOf("let O=1"), "the early map comes before the bootstrap");
  assert.ok(patched.includes(`if(!__nshEarlyMap){${LATE_MAP}}`));
});

test("a runtime without the spots to patch fails the build", async t => {
  const root = await site(t, "async run(e){}");
  assert.throws(() => fixWebSite(root), /longbridge\/nsh#1118/);
});

test("the early map maps the entry, chunks and every native module, whose exports follow the runtime's modules", async () => {
  const appended: { type?: string; textContent?: string }[] = [];
  const f = { createElement: () => ({}), head: { append: (element: object) => appended.push(element) } };
  const document = { baseURI: "https://pikibun.test/" };
  const urls: string[] = [];
  const run = new Function("v", "e", "o", "s", "c", "x", "f", "document", `${BEFORE_BOOTSTRAP}${EARLY_MAP}return __nshEarlyMap;`);
  const map = run(true, "app.1d48db9d4c.js", { extra: "https://pikibun.test/extra.js" }, { "./chunk.js": "chunk.0123456789.js" },
    { nsh: ["signal", "default"], "nsh:rt": ["text"] }, urls, f, document);
  const importMap = appended.find(element => element.type === "importmap");
  assert.deepEqual(JSON.parse(importMap!.textContent!).imports, map);
  assert.equal(map["extra"], "https://pikibun.test/extra.js");
  assert.equal(map["https://pikibun.test/bundle.js"], "https://pikibun.test/app.1d48db9d4c.js");
  assert.equal(map["https://pikibun.test/chunk.js"], "https://pikibun.test/chunk.0123456789.js");
  assert.deepEqual(urls, [map["nsh"], map["nsh:rt"]]);

  // The `nsh` module, run as the browser would once the bootstrap has set up the realm.
  const source = await resolveObjectURL(map["nsh"])!.text();
  const watchers: (() => void)[] = [];
  const nsh: Record<string, unknown> = { signal: 1 };
  (globalThis as any).__nsh_browser_realm = { modules: new Map([["nsh", nsh]]), watch: (watcher: () => void) => watchers.push(watcher) };
  try {
    const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);
    assert.equal(module.signal, 1);
    assert.equal(module.default, undefined);
    nsh.default = "late";
    for (const watcher of watchers) watcher();
    assert.equal(module.default, "late");
  } finally {
    delete (globalThis as any).__nsh_browser_realm;
  }
});
