import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

export const MEASURE_TEXT = "measure_text:(e,t,n,r)=>(++this.measureUses>=5e3&&(this.measureUses=0,this.measure=R()),this.measure.font=this.str(e,t),this.measure.measureText(this.str(n,r)).width)";
export const PATCHED_MEASURE_TEXT = "measure_text:(e,t,n,r)=>(++this.measureUses>=5e3&&(this.measureUses=0,this.measure=R()),__pikibunTextWidth(this.measure,this.str(e,t),this.str(n,r)))";

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
  const loader = only(entries, /^nsh\.[0-9a-f]{10}\.js$/, "nsh.<hash>.js");
  const loaderSource = readFileSync(path.join(site, loader), "utf8");
  if (loaderSource.split(MEASURE_TEXT).length !== 2) {
    throw new Error(`nsh-web-fixes: ${loader} has no single measure_text to patch. If the pinned Native Shell measures text as the page draws it, remove scripts/nsh-web-fixes.mjs; otherwise update MEASURE_TEXT and PATCHED_MEASURE_TEXT.`);
  }
  const newLoaderSource = `${DRAWN_WIDTH}\n${loaderSource}`.replace(MEASURE_TEXT, () => PATCHED_MEASURE_TEXT);
  const newLoader = `nsh.${hash10(newLoaderSource)}.js`;
  const loaderCompressed = existsSync(path.join(site, `${loader}.br`));
  removeWithCompressed(path.join(site, loader));
  writeWithCompressed(path.join(site, newLoader), newLoaderSource, loaderCompressed);

  let referenced = false;
  for (const name of readdirSync(site)) {
    const file = path.join(site, name);
    if (!/\.(html|js|json|webmanifest)$/.test(name) || !statSync(file).isFile()) continue;
    const text = readFileSync(file, "utf8");
    if (!text.includes(loader)) continue;
    referenced = true;
    writeWithCompressed(file, text.replaceAll(loader, newLoader), existsSync(`${file}.br`));
  }
  if (!referenced) throw new Error(`nsh-web-fixes: nothing in ${site} loads ${loader}`);
  return { loader: newLoader };
}
