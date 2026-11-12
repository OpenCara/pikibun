import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DRAWN_WIDTH, MEASURE_TEXT, PATCHED_MEASURE_TEXT, fixWebSite } from "../scripts/nsh-web-fixes.mjs";

const LOADER = `import(\`./browser.991ab24c49/runtime.js\`);const imports={nsh:{${MEASURE_TEXT},measure_numeric_text:()=>0}};`;

async function site(t: test.TestContext, loader = LOADER) {
  const root = await mkdtemp(join(tmpdir(), "nsh-site-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "browser.991ab24c49"));
  await writeFile(join(root, "browser.991ab24c49", "runtime.js"), "runtime");
  await writeFile(join(root, "nsh.89070fe10a.js"), loader);
  await writeFile(join(root, "nsh.89070fe10a.js.br"), "stale");
  await writeFile(join(root, "index.html"), `<script type="module">import { createPlayer } from "./nsh.89070fe10a.js";</script>`);
  return root;
}

test("text is measured as the page draws it, in a renamed loader", async t => {
  const root = await site(t);
  const { loader } = fixWebSite(root);
  const names = await readdir(root);
  assert.ok(!names.includes("nsh.89070fe10a.js") && !names.includes("nsh.89070fe10a.js.br"));
  assert.match(loader, /^nsh\.[0-9a-f]{10}\.js$/);
  assert.ok(existsSync(join(root, `${loader}.br`)) && existsSync(join(root, `${loader}.gz`)));
  assert.equal(await readFile(join(root, "index.html"), "utf8"), `<script type="module">import { createPlayer } from "./${loader}";</script>`);
  assert.equal(await readFile(join(root, loader), "utf8"), `${DRAWN_WIDTH}\n${LOADER.replace(MEASURE_TEXT, PATCHED_MEASURE_TEXT)}`);
  assert.equal(await readFile(join(root, "browser.991ab24c49", "runtime.js"), "utf8"), "runtime", "the runtime is left as it is");
});

test("a loader without the measure_text it patches fails the build", async t => {
  const root = await site(t, "import(`./browser.991ab24c49/runtime.js`)");
  assert.throws(() => fixWebSite(root), /no single measure_text/);
});

function textWidth(drawn: (font: string, text: string) => number, measured: (font: string, text: string) => number, { body = true } = {}) {
  type Node = {
    style: Record<string, string>; textContent: string; isConnected: boolean;
    setAttribute(): void; append(child: Node): void; getBoundingClientRect(): { width: number };
  };
  const spans: Node[] = [];
  const fontListeners: (() => void)[] = [];
  const element = (): Node => {
    const node: Node = {
      style: {}, textContent: "", isConnected: false,
      setAttribute() {},
      append(child) { child.isConnected = true; },
      getBoundingClientRect: () => ({ width: drawn(node.style.font ?? "", node.textContent) }),
    };
    spans.push(node);
    return node;
  };
  const document = {
    createElement: element,
    body: body ? { append(child: Node) { child.isConnected = true; } } : null,
    fonts: { addEventListener: (type: string, listener: () => void) => type === "loadingdone" && fontListeners.push(listener) },
  };
  const width = new Function("document", `${DRAWN_WIDTH};return __pikibunTextWidth;`)(document);
  const context = { font: "", measureText(text: string) { return { width: measured(this.font, text) }; } };
  return { measure: (font: string, text: string) => width(context, font, text) as number, context, fontsLoaded: () => fontListeners.forEach(f => f()), spans };
}

const SYSTEM = "400 15px -apple-system, BlinkMacSystemFont, sans-serif";
const CODE = "400 13px monospace, -apple-system, BlinkMacSystemFont, sans-serif";

test("text in a font the canvas measures as the page draws it is measured on the canvas", () => {
  const page = textWidth((_, text) => text.length * 7, (_, text) => text.length * 7);
  assert.equal(page.measure(SYSTEM, "repositories"), 84);
  assert.equal(page.context.font, SYSTEM);
  page.spans.at(-1)!.textContent = "";
  assert.equal(page.measure(SYSTEM, "and"), 21);
  assert.equal(page.spans.at(-1)!.textContent, "");
});

test("text in a font the canvas measures narrower than the page draws it is measured as the page draws it", () => {
  const inDom: string[] = [];
  const drawn = (font: string, text: string) => {
    if (!text.startsWith("The quick")) inDom.push(text);
    return text.length * (font === SYSTEM ? 8 : 7.8);
  };
  const measured = (font: string, text: string) => text.length * (font === SYSTEM ? 7.2 : 7.8);
  const page = textWidth(drawn, measured);
  assert.equal(page.measure(SYSTEM, "If the answer is "), 17 * 8);
  assert.equal(page.measure(CODE, "10.x"), 4 * 7.8);
  assert.equal(page.measure(SYSTEM, "repositories"), 12 * 8);
  assert.deepEqual(inDom, ["If the answer is ", "repositories"], "only the system font's text is drawn to be measured");
});

test("a difference within half a pixel or 0.2% keeps the canvas", () => {
  const page = textWidth((_, text) => text.length * 7 + 0.4, (_, text) => text.length * 7);
  assert.equal(page.measure(SYSTEM, "and"), 21);
});

test("before the page has a body the canvas measures, and the font is decided later", () => {
  const page = textWidth((_, text) => text.length * 8, (_, text) => text.length * 7, { body: false });
  assert.equal(page.measure(SYSTEM, "and"), 21);
  assert.equal(page.spans.length, 0);
});

test("a font that loads decides each font again", () => {
  let loaded = false;
  const page = textWidth((_, text) => text.length * (loaded ? 8 : 7), (_, text) => text.length * 7);
  assert.equal(page.measure(SYSTEM, "and"), 21);
  loaded = true;
  assert.equal(page.measure(SYSTEM, "and"), 21, "decided until a font loads");
  page.fontsLoaded();
  assert.equal(page.measure(SYSTEM, "and"), 24);
});
