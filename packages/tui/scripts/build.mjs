#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { NSH_TUI_HOSTS, NSH_VERSION, nshBinary, unpackPinned } from "../../../scripts/nsh.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = path.resolve(root, "..", "..");
const app = path.join(repository, "apps", "nsh");
export const APP_ID = "com.pikibun.tui";
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const usage = `Usage: node packages/tui/scripts/build.mjs [--version 1.2.3] [--hosts current|all|linux-x64,...] [--app <nsh build output>] [--out <dir>]

Builds the npm packages of Pikibun's terminal app into <out> (packages/tui/dist): tui/, @pikibun/tui with the launcher
and the app's bundle, and hosts/<platform>-<arch>/, @pikibun/tui-<platform>-<arch> with Native Shell ${NSH_VERSION}'s
terminal host for that computer, checked against the SHA-256 scripts/nsh.mjs pins.
`;

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    hosts: { type: "string", default: "current" },
    app: { type: "string" },
    out: { type: "string", default: path.join(root, "dist") },
    help: { type: "boolean" },
  },
});
if (values.help) {
  process.stdout.write(usage);
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = values.version ?? manifest.version;
if (!VERSION.test(version)) throw new Error(`Not a semantic version: ${JSON.stringify(version)}.\n${usage}`);
const allHosts = Object.keys(NSH_TUI_HOSTS);
const current = `${process.platform}-${process.arch}`;
const hosts = values.hosts === "all" ? allHosts : values.hosts === "current" ? [current] : values.hosts.split(",").map(host => host.trim()).filter(Boolean);
for (const host of hosts) if (!NSH_TUI_HOSTS[host]) throw new Error(`No terminal host is pinned for ${host} (${allHosts.join(", ")}).`);
const out = path.resolve(values.out);
rmSync(out, { recursive: true, force: true });

const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const [platformOf, archOf] = [host => host.split("-")[0], host => host.split("-")[1]];

function appBundle() {
  if (values.app) return path.resolve(values.app);
  const staging = path.join(out, ".nsh-build");
  return nshBinary().then(bin => {
    const built = spawnSync(bin, ["build", "App.tsx", "--release", "--out", staging], { cwd: app, stdio: "inherit", env: { ...process.env, NO_COLOR: process.env.NO_COLOR ?? "1" } });
    if (built.error) throw built.error;
    if (built.status !== 0) throw new Error(`nsh build exited with ${built.status}`);
    return staging;
  });
}

async function mainPackage() {
  const target = path.join(out, "tui");
  const built = await appBundle();
  for (const needed of ["bundle.js", "capabilities.json"]) {
    if (!existsSync(path.join(built, needed))) throw new Error(`${built} has no ${needed}: is it what nsh build wrote?`);
  }
  mkdirSync(path.join(target, "app"), { recursive: true });
  for (const name of readdirSync(built)) {
    if (name.endsWith(".nshc")) continue;
    cpSync(path.join(built, name), path.join(target, "app", name), { recursive: true });
  }
  writeJson(path.join(target, "app", "app.json"), { id: APP_ID, name: "Pikibun" });
  if (!values.app) rmSync(built, { recursive: true, force: true });
  await build({
    entryPoints: [path.join(root, "src", "bin.ts")], outfile: path.join(target, "bin", "pikibun-tui.js"), bundle: true,
    platform: "node", format: "esm", target: "node18", banner: { js: "#!/usr/bin/env node" }, logLevel: "warning",
  });
  chmodSync(path.join(target, "bin", "pikibun-tui.js"), 0o755);
  const published = { ...manifest };
  delete published.scripts;
  writeJson(path.join(target, "package.json"), {
    ...published, version,
    optionalDependencies: Object.fromEntries(allHosts.map(host => [`@pikibun/tui-${host}`, version])),
  });
  cpSync(path.join(root, "README.md"), path.join(target, "README.md"));
  cpSync(path.join(repository, "LICENSE"), path.join(target, "LICENSE"));
  return target;
}

async function hostPackage(host) {
  const target = path.join(out, "hosts", host);
  const partial = path.join(out, `.${host}.partial`);
  await unpackPinned(NSH_TUI_HOSTS[host], partial, `the terminal host for ${host}`);
  const runtime = path.join(partial, "nsh", "runtime", "tui");
  const binary = ["nsh-tui-host", "nsh-tui-host.exe"].find(name => existsSync(path.join(runtime, name)));
  if (!binary) throw new Error(`${NSH_TUI_HOSTS[host]} holds no nsh/runtime/tui/nsh-tui-host`);
  const wanted = platformOf(host) === "win32" ? "nsh-tui-host.exe" : "nsh-tui-host";
  if (wanted !== binary) throw new Error(`${NSH_TUI_HOSTS[host]} holds ${binary}, where ${wanted} was expected for ${host}`);
  mkdirSync(path.join(target, "bin"), { recursive: true });
  cpSync(path.join(runtime, binary), path.join(target, "bin", wanted));
  chmodSync(path.join(target, "bin", wanted), 0o755);
  rmSync(partial, { recursive: true, force: true });
  writeJson(path.join(target, "package.json"), {
    name: `@pikibun/tui-${host}`, version,
    description: `The terminal host of Pikibun's terminal app (@pikibun/tui) for ${host}: Native Shell ${NSH_VERSION}'s nsh-tui-host.`,
    license: "Apache-2.0", homepage: manifest.homepage, repository: manifest.repository,
    os: [platformOf(host)], cpu: [archOf(host)], files: ["bin", "README.md", "LICENSE"], preferUnplugged: true,
  });
  writeFileSync(path.join(target, "README.md"), `# @pikibun/tui-${host}\n\nThe terminal host that [@pikibun/tui](https://www.npmjs.com/package/@pikibun/tui) runs Pikibun's app in on ${host}: \`nsh-tui-host\` from [Native Shell](https://github.com/longbridge/nsh) ${NSH_VERSION}, as Native Shell publishes it, under the Apache License 2.0 (LICENSE). Install @pikibun/tui, not this package: npm picks this one for the computer it installs on.\n`);
  cpSync(path.join(root, "NSH-LICENSE"), path.join(target, "LICENSE"));
  return target;
}

const made = [await mainPackage()];
for (const host of hosts) made.push(await hostPackage(host));
console.error(`Pikibun's terminal app ${version}, with Native Shell ${NSH_VERSION}:\n${made.map(dir => `  ${path.relative(process.cwd(), dir) || dir}`).join("\n")}`);
