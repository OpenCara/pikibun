#!/usr/bin/env node
/**
 * Runs the Native Shell CLI the client (apps/nsh) is built with, at the version pinned here, in apps/nsh:
 *
 *   node scripts/nsh.mjs <nsh arguments...>      # e.g. check, test, run --target ios
 *   node scripts/nsh.mjs --build-web [out]       # the web app into dist/web (or out), as the server serves it
 *
 * The CLI is `NSH_BIN` when set; otherwise the pinned release, downloaded once into .cache/nsh/<version> (Linux x86_64,
 * Apple-silicon macOS and x86_64 Windows, which NSH publishes) and checked against its SHA-256; otherwise `nsh` on PATH.
 * Each release packages for its own platforms: Linux's for Linux, Android and the web, macOS's for macOS, iOS and the
 * web, Windows's for Windows and the web.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixWebSite } from "./nsh-web-fixes.mjs";

export const NSH_VERSION = "v0.4.0";
/** The commit NSH_VERSION's tag names, for what is built from its source (release-app.yml's iPhone runner). */
export const NSH_COMMIT = "e626a8dd8f8d8b277b9507cfd5ac74d0e67020f3";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(repository, "apps", "nsh");

function release() {
  if (platform() === "linux" && arch() === "x64") return "nsh-linux-x86_64.tar.gz";
  if (platform() === "darwin" && arch() === "arm64") return "nsh-macos-arm64.tar.gz";
  if (platform() === "win32" && arch() === "x64") return "nsh-windows-x86_64.zip";
  return null;
}

const apiAssets = new Map();

async function apiAsset(source) {
  if (!apiAssets.has(source.pathname)) {
    const metadata = await fetch(`https://api.github.com/repos/longbridge/nsh/releases/tags/${NSH_VERSION}`, {
      headers: { Accept: 'application/vnd.github+json', 'Cache-Control': 'no-cache' },
    });
    if (!metadata.ok) throw new Error(`Release metadata: HTTP ${metadata.status}`);
    const release = await metadata.json();
    for (const asset of release.assets || []) {
      if (/^https:\/\/api\.github\.com\/repos\/longbridge\/nsh\/releases\/assets\/[0-9]+$/.test(asset.url)) {
        apiAssets.set(`/longbridge/nsh/releases/download/${NSH_VERSION}/${asset.name}`, asset.url);
      }
    }
  }
  const url = apiAssets.get(source.pathname);
  if (!url) throw new Error(`No API asset for ${source.pathname}`);
  return new URL(url);
}

/** Retry upstream failures, including gateways that return an HTML error page with HTTP 200 for a checksum. */
export async function releaseAsset(url, { checksum = false, attempts = 4, delayMs = 2000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const source = new URL(url);
      const viaApi = attempt % 2 === 0 && source.origin === 'https://github.com'
        && source.pathname.startsWith(`/longbridge/nsh/releases/download/${NSH_VERSION}/`);
      // GitHub's release API gives us another route to the same published bytes if its browser download gateway fails.
      const request = viaApi ? await apiAsset(source) : source;
      if (attempt > 1) request.searchParams.set('_pikibun_retry', `${Date.now()}-${attempt}`);
      const response = await fetch(request, { headers: { 'Cache-Control': 'no-cache', ...(viaApi ? { Accept: 'application/octet-stream' } : {}) } });
      if (!response.ok) throw new Error(`downloading ${new URL(url).pathname}: HTTP ${response.status}`);
      if (!checksum) return Buffer.from(await response.arrayBuffer());
      const hash = (await response.text()).trim().split(/\s+/)[0];
      if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error('The release checksum response is not a SHA-256 hash');
      return hash.toLowerCase();
    } catch (error) {
      if (attempt === attempts) throw error;
      console.error(`Release download attempt ${attempt}/${attempts} failed: ${error.message}; retrying`);
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
}

async function download(asset, directory) {
  const base = `https://github.com/longbridge/nsh/releases/download/${NSH_VERSION}`;
  const expected = await releaseAsset(`${base}/${asset}.sha256`, { checksum: true });
  console.error(`Downloading Native Shell ${NSH_VERSION} (${asset}, several hundred MB, once)…`);
  const bytes = await releaseAsset(`${base}/${asset}`);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`${asset} does not match its published SHA-256 (${actual} != ${expected})`);
  const partial = `${directory}.partial`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  const archive = path.join(partial, asset);
  writeFileSync(archive, bytes);
  // Windows' own tar (bsdtar) reads the zip too.
  const untar = spawnSync("tar", [asset.endsWith(".zip") ? "-xf" : "-xzf", archive, "-C", partial], { stdio: "inherit" });
  if (untar.status !== 0) throw new Error(`extracting ${asset} failed`);
  rmSync(archive);
  rmSync(directory, { recursive: true, force: true });
  renameSync(partial, directory);
}

/** The nsh executable to run. */
export async function nshBinary() {
  if (process.env.NSH_BIN) return process.env.NSH_BIN;
  const asset = release();
  if (asset) {
    const directory = path.join(repository, ".cache", "nsh", NSH_VERSION);
    const bin = path.join(directory, "nsh", "bin", platform() === "win32" ? "nsh.exe" : "nsh");
    if (!existsSync(bin)) await download(asset, directory);
    return bin;
  }
  const found = spawnSync("nsh", ["--version"], { encoding: "utf8" });
  if (found.status === 0) {
    if (!found.stdout.includes(NSH_VERSION.slice(1))) console.error(`warning: ${found.stdout.trim()} on PATH; the client is built with ${NSH_VERSION}.`);
    return "nsh";
  }
  throw new Error(`Install Native Shell ${NSH_VERSION} (https://nsh.dev/docs/installation) or set NSH_BIN.`);
}

function run(bin, args) {
  const result = spawnSync(bin, args, { cwd: app, stdio: "inherit", env: { ...process.env, NO_COLOR: process.env.NO_COLOR ?? "1" } });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** Packages the web app into `out` (dist/web by default): the static site the server and `pikibun serve` serve. */
export async function buildWeb(out = path.join(repository, "dist", "web")) {
  const bin = await nshBinary();
  const staging = path.join(repository, "dist", ".nsh-web");
  rmSync(staging, { recursive: true, force: true });
  const status = run(bin, ["package", "App.tsx", "--target", "web", "--out", staging]);
  if (status !== 0) throw new Error(`nsh package exited with ${status}`);
  // nsh writes the site into a directory named after the app.
  const [site] = readdirSync(staging);
  if (!site || !existsSync(path.join(staging, site, "index.html"))) throw new Error(`nsh package wrote no site into ${staging}`);
  // Firefox and older Safari: the import map before the first module (longbridge/nsh#582).
  fixWebSite(path.join(staging, site));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(path.dirname(out), { recursive: true });
  cpSync(path.join(staging, site), out, { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  console.error(`The web app is in ${path.relative(repository, out) || out}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [first, ...rest] = process.argv.slice(2);
  try {
    if (first === "--build-web") await buildWeb(rest[0] ? path.resolve(rest[0]) : undefined);
    else process.exitCode = run(await nshBinary(), [first, ...rest].filter(argument => argument !== undefined));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
