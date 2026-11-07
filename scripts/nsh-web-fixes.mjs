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
 * The patched runtime goes into a renamed `browser.<hash>` directory, and the file that imports it into a renamed
 * `nsh.<hash>.js`, so no browser or CDN keeps serving a cached unpatched copy (`nsh.<hash>.js` is cached as immutable).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

/** Where the runtime has created the app's iframe document `f` (with its <base>) and not yet loaded any module into it. */
export const BEFORE_BOOTSTRAP = "if(v){let e=f.createElement(`base`);e.href=document.baseURI,f.head.append(e)}";
/** The runtime's late import map, inserted after the bootstrap has run. */
export const LATE_MAP = "let Q=f.createElement(`script`);Q.type=`importmap`,Q.textContent=JSON.stringify({imports:Y}),f.head.append(Q);";

/**
 * Inserted after BEFORE_BOOTSTRAP, in `run(e, {imports: o, chunks: s, nativeExports: c})`, where `x` holds the blob URLs
 * the runtime revokes when the app stops. Builds the map as the runtime's late code does (entry, chunks, imports) plus a
 * module for every native module in `nativeExports`. Only in an iframe (`v`): a page that runs the app in its own
 * document has loaded modules already, and keeps the runtime's own behaviour.
 */
export const EARLY_MAP = String.raw`let __nshEarlyMap=null;if(v){__nshEarlyMap=Object.assign({},o);let X0=new URL(e,document.baseURI),Z0=X0.protocol==="blob:"?new URL(document.baseURI):X0;Z0===X0&&(__nshEarlyMap[new URL("bundle.js",X0).href]=X0.href);for(let[k0,u0]of Object.entries(s))__nshEarlyMap[new URL(k0,Z0).href]=new URL(u0,document.baseURI).href;for(let[k0,n0]of Object.entries(c)){let K0=JSON.stringify(k0),L0=["const host=globalThis.__nsh_browser_realm.modules;"],W0=[];n0.forEach((m0,j0)=>{let N0=JSON.stringify(m0);L0.push("let l"+j0+"=host.get("+K0+")["+N0+"];export{l"+j0+" as "+N0+"};"),W0.push("l"+j0+"=host.get("+K0+")["+N0+"];")}),W0.length&&L0.push("globalThis.__nsh_browser_realm.watch(()=>{"+W0.join("")+"});");let B0=URL.createObjectURL(new Blob([L0.join("\n")],{type:"text/javascript"}));x.push(B0),__nshEarlyMap[k0]=B0}let Q0=f.createElement("script");Q0.type="importmap",Q0.textContent=JSON.stringify({imports:__nshEarlyMap}),f.head.append(Q0)}`;

const hash10 = text => createHash("sha256").update(text).digest("hex").slice(0, 10);

function only(entries, pattern, what) {
  const found = entries.filter(name => pattern.test(name));
  if (found.length !== 1) throw new Error(`nsh-web-fixes: expected one ${what}, found ${found.length}`);
  return found[0];
}

/** Writes `file` and its precompressed .br/.gz beside it, when the site has them, so none goes stale. */
function writeWithCompressed(file, content, compressed) {
  writeFileSync(file, content);
  if (!compressed) return;
  writeFileSync(`${file}.br`, brotliCompressSync(content, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
  writeFileSync(`${file}.gz`, gzipSync(content, { level: 9 }));
}

function removeWithCompressed(file) {
  for (const name of [file, `${file}.br`, `${file}.gz`]) rmSync(name, { force: true });
}

/** Applies the fix to the site in `site`. Throws when the runtime isn't the one it was written for. */
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

  // New names for the patched runtime's directory and for the file that imports it, and everything naming those.
  const newBrowserDir = `browser.${hash10(`${browserDir}\n${patched}`)}`;
  renameSync(path.join(site, browserDir), path.join(site, newBrowserDir));
  const loaderSource = readFileSync(path.join(site, loader), "utf8");
  if (!loaderSource.includes(`./${browserDir}/`)) throw new Error(`nsh-web-fixes: ${loader} does not import ./${browserDir}/`);
  const newLoaderSource = loaderSource.replaceAll(`./${browserDir}/`, `./${newBrowserDir}/`);
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
