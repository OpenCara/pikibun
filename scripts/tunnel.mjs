#!/usr/bin/env node
/**
 * Puts this checkout's Pikibun online through a Cloudflare quick tunnel, for trying the client from anywhere: builds it
 * for the web, starts the server and `cloudflared` in the background, and prints the public address with an
 * administrator's password. Sign-ups are off and the only account is that administrator.
 *
 *   node scripts/tunnel.mjs start [--local]   # in the background; --local: no tunnel, on 127.0.0.1 only, where the
 *                                             # pages load but signing in needs the tunnel's https address
 *   node scripts/tunnel.mjs run [--local]     # the same in the foreground, until Ctrl-C (for tmux or a service manager)
 *   node scripts/tunnel.mjs status
 *   node scripts/tunnel.mjs stop
 *
 * Needs Node 24 and network access; downloads `cloudflared` into .tunnel/ when it isn't on PATH, and the Native Shell
 * CLI as scripts/nsh.mjs does.
 * Its state (database, logs, the password) stays in .tunnel/, which is git-ignored.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { arch, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWeb } from "./nsh.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(repo, ".tunnel");
const stateFile = path.join(dir, "state.json");
const [command = "status", ...flags] = process.argv.slice(2);
const local = flags.includes("--local");
mkdirSync(dir, { recursive: true });

const sleep = ms => new Promise(done => setTimeout(done, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readState = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null);
const onPath = name => spawnSync(platform() === "win32" ? "where" : "which", [name], { encoding: "utf8" }).status === 0;

function run(program, args, options = {}) {
  console.log(`$ ${program} ${args.join(" ")}`);
  const result = spawnSync(program, args, { cwd: repo, stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${program} exited with ${result.status ?? result.error?.message}`);
}

async function download(url, file) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`downloading ${url}: HTTP ${response.status}`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

async function cloudflared() {
  if (onPath("cloudflared")) return "cloudflared";
  const bin = path.join(dir, "cloudflared");
  if (existsSync(bin)) return bin;
  const cpu = arch() === "arm64" ? "arm64" : "amd64";
  const base = "https://github.com/cloudflare/cloudflared/releases/latest/download";
  if (platform() === "linux") {
    await download(`${base}/cloudflared-linux-${cpu}`, bin);
  } else if (platform() === "darwin") {
    const archive = path.join(dir, "cloudflared.tgz");
    await download(`${base}/cloudflared-darwin-${cpu}.tgz`, archive);
    run("tar", ["-xzf", archive, "-C", dir]);
  } else {
    throw new Error("Install cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and run this again.");
  }
  chmodSync(bin, 0o755);
  return bin;
}

async function freePort() {
  const server = createServer();
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise(done => server.close(done));
  return port;
}

async function status() {
  const state = readState();
  if (!state) return console.log("Not running. Start it with: node scripts/tunnel.mjs start");
  console.log(`Address:  ${state.url}`);
  console.log(`Sign in:  ${state.username} / ${state.password}`);
  console.log(`Server:   ${alive(state.serverPid) ? "running" : "stopped"} on 127.0.0.1:${state.port} (log: .tunnel/server.log)`);
  if (state.tunnelPid) console.log(`Tunnel:   ${alive(state.tunnelPid) ? "running" : "stopped"} (log: .tunnel/cloudflared.log)`);
  try {
    const health = await fetch(`${state.url}/api/health`, { signal: AbortSignal.timeout(15_000) });
    console.log(`Reachable: ${health.ok ? "yes" : `HTTP ${health.status}`}`);
  } catch (error) {
    console.log(`Reachable: no (${error.message})`);
  }
}

function stop() {
  const state = readState();
  for (const pid of [state?.serverPid, state?.tunnelPid]) {
    if (!pid || !alive(pid)) continue;
    try { process.kill(-pid, "SIGTERM"); } catch { process.kill(pid, "SIGTERM"); }
  }
  rmSync(stateFile, { force: true });
  console.log("Stopped.");
}

async function start() {
  if (readState()) stop();
  // The server's dependencies, then the client built for the web.
  run("npx", ["--yes", "pnpm@10.32.1", "install", "--frozen-lockfile"]);
  await buildWeb(path.join(repo, "dist", "preview"));

  const port = await freePort();
  let url = `http://127.0.0.1:${port}`;
  let tunnelPid = null;
  if (!local) {
    const log = path.join(dir, "cloudflared.log");
    const tunnel = spawn(await cloudflared(), ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
      detached: true, stdio: ["ignore", openSync(log, "w"), openSync(log, "a")],
    });
    tunnel.unref();
    tunnelPid = tunnel.pid;
    url = "";
    for (let i = 0; i < 60 && !url; i++) {
      await sleep(1000);
      url = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/.exec(readFileSync(log, "utf8"))?.[0] ?? "";
      if (!alive(tunnel.pid)) break;
    }
    if (!url) throw new Error(`cloudflared gave no address:\n${readFileSync(log, "utf8")}`);
  }

  const data = path.join(dir, "data");
  mkdirSync(data, { recursive: true });
  const secretsFile = path.join(dir, "secrets.json");
  // The database's keys stay the same across restarts, so its sign-ins and encrypted values survive one.
  const secrets = existsSync(secretsFile) ? JSON.parse(readFileSync(secretsFile, "utf8")) : {
    SESSION_SECRET: randomBytes(36).toString("base64url"), VAULT_KEY: randomBytes(32).toString("base64url"), password: randomBytes(18).toString("base64url"),
  };
  writeFileSync(secretsFile, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  const env = {
    ...process.env,
    APP_ORIGIN: url, HOST: "127.0.0.1", PORT: String(port), TRUST_PROXY: local ? "false" : "true",
    DATABASE_URL: `sqlite://${path.join(data, "pikibun.sqlite")}`,
    SESSION_SECRET: secrets.SESSION_SECRET, VAULT_KEY: secrets.VAULT_KEY,
    PASSWORD_AUTH: "true", SIGNUP: "off", ADMIN_USER_IDS: "password:admin",
    STATIC_DIR: path.join(repo, "dist/preview"), STATIC_CLIENT: "nsh",
  };
  const server = ["--import", "tsx", "apps/server/src/main.ts"];
  // The administrator, its password on standard input (never in argv); already there after a restart.
  const admin = spawnSync(process.execPath, [...server, "--create-admin", "admin"], { cwd: repo, env, input: `${secrets.password}\n`, encoding: "utf8" });
  console.log((admin.stdout + admin.stderr).trim());
  const log = path.join(dir, "server.log");
  const child = spawn(process.execPath, server, { cwd: repo, env, detached: true, stdio: ["ignore", openSync(log, "w"), openSync(log, "a")] });
  child.unref();
  let healthy = false;
  for (let i = 0; i < 60 && !healthy; i++) {
    await sleep(1000);
    try { healthy = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { /* starting */ }
    if (!alive(child.pid)) break;
  }
  if (!healthy) throw new Error(`the server did not start:\n${readFileSync(log, "utf8")}`);
  writeFileSync(stateFile, JSON.stringify({ url, port, serverPid: child.pid, tunnelPid, username: "admin", password: secrets.password }, null, 2), { mode: 0o600 });
  // A new quick tunnel's name takes a moment to resolve.
  for (let i = 0; i < 30; i++) {
    try { if ((await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) })).ok) break; } catch { /* not yet */ }
    await sleep(2000);
  }
  await status();
}

if (command === "start") await start();
else if (command === "run") {
  await start();
  console.log("\nRunning until Ctrl-C.");
  const state = readState();
  const end = () => { stop(); process.exit(0); };
  process.on("SIGINT", end);
  process.on("SIGTERM", end);
  // Ends with the server or the tunnel, so a service manager restarts the pair.
  for (;;) {
    await sleep(5000);
    if (!alive(state.serverPid) || (state.tunnelPid && !alive(state.tunnelPid))) {
      console.error("The server or the tunnel stopped; see .tunnel/*.log.");
      stop();
      process.exit(1);
    }
  }
} else if (command === "stop") stop();
else await status();
