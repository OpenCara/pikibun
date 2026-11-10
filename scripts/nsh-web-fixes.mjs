import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

export const BEFORE_BOOTSTRAP = "if(v){let e=f.createElement(`base`);e.href=document.baseURI,f.head.append(e)}";
export const LATE_MAP = "let Q=f.createElement(`script`);Q.type=`importmap`,Q.textContent=JSON.stringify({imports:Y}),f.head.append(Q);";

export const EARLY_MAP = String.raw`let __nshEarlyMap=null;if(v){__nshEarlyMap=Object.assign({},o);let X0=new URL(e,document.baseURI),Z0=X0.protocol==="blob:"?new URL(document.baseURI):X0;Z0===X0&&(__nshEarlyMap[new URL("bundle.js",X0).href]=X0.href);for(let[k0,u0]of Object.entries(s))__nshEarlyMap[new URL(k0,Z0).href]=new URL(u0,document.baseURI).href;for(let[k0,n0]of Object.entries(c)){let K0=JSON.stringify(k0),L0=["const host=globalThis.__nsh_browser_realm.modules;"],W0=[];n0.forEach((m0,j0)=>{let N0=JSON.stringify(m0);L0.push("let l"+j0+"=host.get("+K0+")["+N0+"];export{l"+j0+" as "+N0+"};"),W0.push("l"+j0+"=host.get("+K0+")["+N0+"];")}),W0.length&&L0.push("globalThis.__nsh_browser_realm.watch(()=>{"+W0.join("")+"});");let B0=URL.createObjectURL(new Blob([L0.join("\n")],{type:"text/javascript"}));x.push(B0),__nshEarlyMap[k0]=B0}let Q0=f.createElement("script");Q0.type="importmap",Q0.textContent=JSON.stringify({imports:__nshEarlyMap}),f.head.append(Q0)}`;

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
