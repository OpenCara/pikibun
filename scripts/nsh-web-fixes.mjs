/**
 * Fixes to the web site `nsh package --target web` writes, applied by scripts/nsh.mjs --build-web until Native Shell
 * ships them itself.
 *
 * Firefox (and older Safari) don't start the app: "The specifier “nsh” was a bare specifier, but was not remapped to
 * anything." Native Shell 0.4's browser runtime (browser.<hash>/runtime.js) loads its bootstrap module into the app's
 * iframe first and only then inserts the import map that maps `nsh`, `nsh/base`, `nsh:rt`… to the modules it builds.
 * A browser takes an import map only before the first module script of the document starts loading: Chrome 133+ merges
 * a later one, Firefox ignores it, so the app's `import … from "nsh"` resolves to nothing. longbridge/nsh#582, fixed
 * upstream by longbridge/nsh#1118 (not released yet). Remove this file once the pinned release has that fix.
 *
 * The fix: before the bootstrap, install the complete map, built from what the runtime already knows then — the
 * bundler's `nativeExports` (every native module the app imports and the names it imports from each), its chunks and
 * its entry. Each native module is a `blob:` module whose exports read the runtime's modules
 * (`globalThis.__nsh_browser_realm.modules`) when it runs, which is after the bootstrap, as the runtime's own late ones
 * do, and follow late-registered values the same way. The runtime's late map is then left out: every browser runs the
 * app from the same map.
 *
 * Text runs into the text after it (inline code over the words before it, a bold phrase over the next ones) where the
 * browser's canvas measures a font narrower or wider than the page draws it. Native Shell 0.4 lays text out with widths
 * from canvas `measureText` and draws each run as a DOM span at the place those widths give, so the two must agree, and
 * in some browsers they don't for the system font stack it writes (`-apple-system, BlinkMacSystemFont, …`): a canvas
 * can resolve it to another face than the page does, and a minimum font size or text-only zoom enlarges the page's text
 * only. The fix: `measure_text` (in nsh.<hash>.js) compares, once per font, a sample measured on canvas with the same
 * sample drawn in a hidden span; where they differ, it measures that font's text in the span, as the page draws it, as
 * NSH already does for text with a numeric variant. Where they agree nothing changes. Not reported upstream yet; remove
 * MEASURE_TEXT and its patch once the pinned release measures what the page draws.
 *
 * The patched runtime goes into a renamed `browser.<hash>` directory, and the file that imports it into a renamed
 * `nsh.<hash>.js`, so no browser or CDN keeps serving a cached unpatched copy (`nsh.<hash>.js` is cached as immutable).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

export const BEFORE_BOOTSTRAP = "if(v){let e=f.createElement(`base`);e.href=document.baseURI,f.head.append(e)}";
export const LATE_MAP = "let Q=f.createElement(`script`);Q.type=`importmap`,Q.textContent=JSON.stringify({imports:Y}),f.head.append(Q);";

export const EARLY_MAP = String.raw`let __nshEarlyMap=null;if(v){__nshEarlyMap=Object.assign({},o);let X0=new URL(e,document.baseURI),Z0=X0.protocol==="blob:"?new URL(document.baseURI):X0;Z0===X0&&(__nshEarlyMap[new URL("bundle.js",X0).href]=X0.href);for(let[k0,u0]of Object.entries(s))__nshEarlyMap[new URL(k0,Z0).href]=new URL(u0,document.baseURI).href;for(let[k0,n0]of Object.entries(c)){let K0=JSON.stringify(k0),L0=["const host=globalThis.__nsh_browser_realm.modules;"],W0=[];n0.forEach((m0,j0)=>{let N0=JSON.stringify(m0);L0.push("let l"+j0+"=host.get("+K0+")["+N0+"];export{l"+j0+" as "+N0+"};"),W0.push("l"+j0+"=host.get("+K0+")["+N0+"];")}),W0.length&&L0.push("globalThis.__nsh_browser_realm.watch(()=>{"+W0.join("")+"});");let B0=URL.createObjectURL(new Blob([L0.join("\n")],{type:"text/javascript"}));x.push(B0),__nshEarlyMap[k0]=B0}let Q0=f.createElement("script");Q0.type="importmap",Q0.textContent=JSON.stringify({imports:__nshEarlyMap}),f.head.append(Q0)}`;

/** Native Shell 0.4's `measure_text` import in nsh.<hash>.js, as `nsh package` minifies it: canvas widths only. */
export const MEASURE_TEXT = "measure_text:(e,t,n,r)=>(++this.measureUses>=5e3&&(this.measureUses=0,this.measure=O()),this.measure.font=this.str(e,t),this.measure.measureText(this.str(n,r)).width)";
/** The same, measuring through DRAWN_WIDTH. */
export const PATCHED_MEASURE_TEXT = "measure_text:(e,t,n,r)=>(++this.measureUses>=5e3&&(this.measureUses=0,this.measure=O()),__pikibunTextWidth(this.measure,this.str(e,t),this.str(n,r)))";

/**
 * Put before nsh.<hash>.js's code: `__pikibunTextWidth(context, font, text)`, the width of `text` in CSS `font` as the
 * page draws it. Per font, once (again after a font loads): whether the canvas `context` measures a sample as a hidden
 * span draws it, within half a pixel or 0.2%. Where it does, the canvas measures; where it doesn't, the span. Before the
 * page has a body there is no span, and the canvas measures without deciding.
 */
export const DRAWN_WIDTH = String.raw`const __pikibunInDom=new Map,__pikibunSample="The quick brown fox jumps over the lazy dog, 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ";let __pikibunSpan=null;typeof document<"u"&&document.fonts?.addEventListener?.("loadingdone",()=>__pikibunInDom.clear());function __pikibunDomWidth(f,s){if(typeof document>"u"||!document.body)return null;if(!__pikibunSpan?.isConnected){let b=document.createElement("div");b.setAttribute("aria-hidden","true");b.style.cssText="position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;contain:strict";__pikibunSpan=document.createElement("span");__pikibunSpan.style.cssText="position:absolute;left:0;top:0;white-space:pre;letter-spacing:normal;word-spacing:normal;text-transform:none;font-kerning:auto;font-feature-settings:normal";b.append(__pikibunSpan);document.body.append(b)}__pikibunSpan.style.font=f;__pikibunSpan.textContent=s;return __pikibunSpan.getBoundingClientRect().width}function __pikibunTextWidth(c,f,s){c.font=f;let d=__pikibunInDom.get(f);if(d===void 0){let w=__pikibunDomWidth(f,__pikibunSample);if(w==null)return c.measureText(s).width;let m=c.measureText(__pikibunSample).width;d=Math.abs(w-m)>Math.max(.5,m*.002);__pikibunInDom.set(f,d)}return d&&__pikibunDomWidth(f,s)||c.measureText(s).width}`;

const hash10 = text => createHash("sha256").update(text).digest("hex").slice(0, 10);

function only(entries, pattern, what) {
  const found = entries.filter(name => pattern.test(name));
  if (found.length !== 1) throw new Error(`nsh-web-fixes: expected one ${what}, found ${found.length}`);
  return found[0];
}

function writeWithCompressed(file, content, compressed) {
  writeFileSync(file, content);
  if (!compressed) return;
  writeFileSync(`${file}.br`, brotliCompressSync(content, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
  writeFileSync(`${file}.gz`, gzipSync(content, { level: 9 }));
}

function removeWithCompressed(file) {
  for (const name of [file, `${file}.br`, `${file}.gz`]) rmSync(name, { force: true });
}

export function fixWebSite(site) {
  const entries = readdirSync(site);
  const browserDir = only(entries, /^browser\.[0-9a-f]{10}$/, "browser.<hash> directory");
  const loader = only(entries, /^nsh\.[0-9a-f]{10}\.js$/, "nsh.<hash>.js");
  const runtimeFile = path.join(site, browserDir, "runtime.js");
  const runtime = readFileSync(runtimeFile, "utf8");
  for (const [needle, what] of [[BEFORE_BOOTSTRAP, "the iframe's <base>"], [LATE_MAP, "the late import map"]]) {
    if (runtime.split(needle).length !== 2) {
      throw new Error(`nsh-web-fixes: ${runtimeFile} has no single ${what} to patch. If the pinned Native Shell starts app realms after their import map (longbridge/nsh#1118), remove scripts/nsh-web-fixes.mjs; otherwise update it.`);
    }
  }
  const patched = runtime
    .replace(BEFORE_BOOTSTRAP, () => BEFORE_BOOTSTRAP + EARLY_MAP)
    .replace(LATE_MAP, () => `if(!__nshEarlyMap){${LATE_MAP}}`);
  writeWithCompressed(runtimeFile, patched, existsSync(`${runtimeFile}.br`));

  const newBrowserDir = `browser.${hash10(`${browserDir}\n${patched}`)}`;
  renameSync(path.join(site, browserDir), path.join(site, newBrowserDir));
  const loaderSource = readFileSync(path.join(site, loader), "utf8");
  if (!loaderSource.includes(`./${browserDir}/`)) throw new Error(`nsh-web-fixes: ${loader} does not import ./${browserDir}/`);
  if (loaderSource.split(MEASURE_TEXT).length !== 2) {
    throw new Error(`nsh-web-fixes: ${loader} has no single measure_text to patch. If the pinned Native Shell measures text as the page draws it, remove MEASURE_TEXT and its patch from scripts/nsh-web-fixes.mjs; otherwise update them.`);
  }
  const newLoaderSource = `${DRAWN_WIDTH}\n${loaderSource}`
    .replace(MEASURE_TEXT, () => PATCHED_MEASURE_TEXT)
    .replaceAll(`./${browserDir}/`, `./${newBrowserDir}/`);
  const newLoader = `nsh.${hash10(newLoaderSource)}.js`;
  const loaderCompressed = existsSync(path.join(site, `${loader}.br`));
  removeWithCompressed(path.join(site, loader));
  writeWithCompressed(path.join(site, newLoader), newLoaderSource, loaderCompressed);

  let referenced = false;
  for (const name of readdirSync(site)) {
    const file = path.join(site, name);
    if (!/\.(html|js|json|webmanifest)$/.test(name) || !statSync(file).isFile()) continue;
    const text = readFileSync(file, "utf8");
    if (!text.includes(loader) && !text.includes(browserDir)) continue;
    referenced = true;
    writeWithCompressed(file, text.replaceAll(loader, newLoader).replaceAll(browserDir, newBrowserDir), existsSync(`${file}.br`));
  }
  if (!referenced) throw new Error(`nsh-web-fixes: nothing in ${site} loads ${loader}`);
  return { runtime: `${newBrowserDir}/runtime.js`, loader: newLoader };
}
