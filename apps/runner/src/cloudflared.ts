import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

export interface CloudflaredToolchain {
  executable: string;
  version?: string;
}

export const SYSTEM_CLOUDFLAREDS: readonly string[] = Object.freeze([
  "/usr/local/bin/cloudflared", "/usr/bin/cloudflared", "/opt/homebrew/bin/cloudflared", "/home/linuxbrew/.linuxbrew/bin/cloudflared",
]);

export const CLOUDFLARED_RELEASES = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";
const DOWNLOAD_PREFIX = "https://github.com/cloudflare/cloudflared/releases/download/";
const DOWNLOAD_HOSTS: readonly string[] = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];
const VERSION = /^\d{4}\.\d{1,2}\.\d{1,3}$/;
const ASSETS: Readonly<Record<string, string>> = Object.freeze({ "linux x64": "cloudflared-linux-amd64", "linux arm64": "cloudflared-linux-arm64" });

export const cloudflaredLimits = Object.freeze({
  bytes: 256 * 1024 * 1024,
  releaseBytes: 2 * 1024 * 1024,
});

export function cloudflaredAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  return ASSETS[`${platform} ${arch}`];
}

function elf(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY);
    const head = Buffer.alloc(4);
    return readSync(fd, head, 0, 4, 0) === 4 && head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function inspectCloudflared(path: string, options: { platform?: NodeJS.Platform } = {}): { cloudflared: CloudflaredToolchain } | { error: string } {
  const platform = options.platform ?? process.platform;
  let executable: string;
  try { executable = realpathSync(path); } catch { return { error: `Nothing is at ${path}` }; }
  try {
    if (!statSync(executable).isFile()) return { error: `${executable} isn't a file` };
    accessSync(executable, constants.X_OK);
  } catch { return { error: `${executable} isn't executable` }; }
  if (platform === "linux" && !elf(executable)) return { error: `${executable} isn't a program but a script or another file: give the cloudflared executable itself` };
  return { cloudflared: { executable } };
}

export function cloudflaredAt(path: string, options: { platform?: NodeJS.Platform } = {}): CloudflaredToolchain | undefined {
  const found = inspectCloudflared(path, options);
  return "cloudflared" in found ? found.cloudflared : undefined;
}

export function hostCloudflared(options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): CloudflaredToolchain | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const at = (path: string) => cloudflaredAt(path, { platform });
  if (env.PIKIBUN_CLOUDFLARED) return at(env.PIKIBUN_CLOUDFLARED);
  const name = platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const onPath = (env.PATH ?? "").split(delimiter).filter(entry => entry.startsWith("/") || /^[A-Za-z]:\\/.test(entry)).map(entry => join(entry, name));
  for (const path of [...onPath, ...SYSTEM_CLOUDFLAREDS]) {
    const found = at(path);
    if (found) return found;
  }
  return undefined;
}

export interface CloudflaredRelease { version: string; asset: string; url: string; sha256: string }

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

async function reach(fetcher: typeof fetch, url: string, signal: AbortSignal | undefined, what: string): Promise<Response> {
  try { return await fetcher(url, { headers: { accept: "application/vnd.github+json, application/octet-stream" }, ...(signal ? { signal } : {}) }); }
  catch (error) {
    if (signal?.aborted) throw error;
    const cause = error instanceof Error && error.cause instanceof Error ? (error.cause as NodeJS.ErrnoException).code ?? error.cause.message : undefined;
    throw new Error(`Couldn't reach ${new URL(url).host} for ${what}${typeof cause === "string" && cause ? ` (${cause.slice(0, 200)})` : ""}`);
  }
}

export async function latestCloudflared(asset: string, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<CloudflaredRelease> {
  const response = await reach(options.fetch ?? fetch, CLOUDFLARED_RELEASES, options.signal, "cloudflared's releases");
  if (!response.ok) throw new Error(`cloudflared's releases answered ${response.status}`);
  const text = await response.text();
  if (text.length > cloudflaredLimits.releaseBytes) throw new Error("cloudflared's release is too long");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("cloudflared's release isn't JSON"); }
  const version = isObject(value) ? value.tag_name : undefined;
  if (typeof version !== "string" || !VERSION.test(version)) throw new Error("cloudflared's latest release has no version");
  const url = `${DOWNLOAD_PREFIX}${version}/${asset}`;
  const assets = isObject(value) && Array.isArray(value.assets) ? value.assets : [];
  if (!assets.some(item => isObject(item) && item.name === asset && item.browser_download_url === url)) throw new Error(`cloudflared ${version} has no ${asset}`);
  const body = isObject(value) && typeof value.body === "string" ? value.body : "";
  const sha256 = new RegExp(`^\\s*${asset.replace(/[.-]/g, "\\$&")}\\s*:\\s*([0-9a-f]{64})\\s*$`, "m").exec(body)?.[1];
  if (!sha256) throw new Error(`cloudflared ${version}'s release lists no SHA-256 for ${asset}`);
  return { version, asset, url, sha256 };
}

export async function downloadedCloudflareds(root: string): Promise<CloudflaredToolchain[]> {
  const names = await readdir(root).catch(() => [] as string[]);
  const newer = (a: string, b: string) => { const x = a.split(".").map(Number); const y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i]! - x[i]!; return 0; };
  return names.filter(name => VERSION.test(name)).sort(newer).flatMap(version => {
    const found = cloudflaredAt(join(root, version, "cloudflared"));
    return found ? [{ ...found, version }] : [];
  });
}

export async function downloadCloudflared(root: string, release: CloudflaredRelease, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<CloudflaredToolchain> {
  if (!VERSION.test(release.version) || release.url !== `${DOWNLOAD_PREFIX}${release.version}/${release.asset}` || !/^[0-9a-f]{64}$/.test(release.sha256)) {
    throw new Error("Not a cloudflared release");
  }
  const target = join(root, release.version);
  const existing = cloudflaredAt(join(target, "cloudflared"));
  if (existing) return { ...existing, version: release.version };
  await mkdir(root, { recursive: true, mode: 0o700 });
  const partial = join(root, `.${release.version}.partial`);
  await rm(partial, { recursive: true, force: true });
  try {
    const response = await reach(options.fetch ?? fetch, release.url, options.signal, "cloudflared's download");
    if (!response.ok || !response.body) throw new Error(`The download answered ${response.status}`);
    if (response.url && !DOWNLOAD_HOSTS.includes(new URL(response.url).host)) throw new Error("cloudflared's download went somewhere else than GitHub");
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > cloudflaredLimits.bytes) throw new Error("The download is larger than cloudflared");
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.length;
      if (received > cloudflaredLimits.bytes) throw new Error("The download is larger than cloudflared");
      chunks.push(Buffer.from(chunk));
    }
    const data = Buffer.concat(chunks);
    if (createHash("sha256").update(data).digest("hex") !== release.sha256) throw new Error("cloudflared's download doesn't match its release's SHA-256");
    await mkdir(partial, { mode: 0o700 });
    await writeFile(join(partial, "cloudflared"), data, { mode: 0o755 });
    await chmod(join(partial, "cloudflared"), 0o755);
    if (!cloudflaredAt(join(partial, "cloudflared"))) throw new Error("The download isn't a cloudflared this host runs");
    await rm(target, { recursive: true, force: true });
    await rename(partial, target);
  } finally {
    await rm(partial, { recursive: true, force: true });
  }
  const found = cloudflaredAt(join(target, "cloudflared"));
  if (!found) throw new Error("The downloaded cloudflared isn't usable");
  return { ...found, version: release.version };
}

export async function pruneCloudflareds(root: string, keep: readonly string[]): Promise<void> {
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (!keep.includes(name)) await rm(join(root, name), { recursive: true, force: true }).catch(() => {});
  }
}
