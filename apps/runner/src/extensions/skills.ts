import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import type { ExtensionSkill, ExtensionSkillFile } from "./protocol.js";

export const extensionSkillLimits = Object.freeze({ skills: 20, files: 50, depth: 8, fileBytes: 256 * 1024, totalBytes: 1024 * 1024, path: 200 });

export function discoveredPath(path: string, extensionPath: string): string | undefined {
  if (isAbsolute(path)) return path;
  if (!isAbsolute(extensionPath)) return undefined;
  return resolve(dirname(extensionPath), path);
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

async function textOf(path: string, left: number): Promise<string | undefined> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.size > Math.min(extensionSkillLimits.fileBytes, left)) return undefined;
  const bytes = await readFile(path).catch(() => undefined);
  if (!bytes || bytes.includes(0)) return undefined;
  return bytes.toString("utf8");
}

async function folderFiles(root: string): Promise<ExtensionSkillFile[]> {
  const files: ExtensionSkillFile[] = [];
  let bytes = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > extensionSkillLimits.depth) return;
    const entries = (await readdir(directory, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name));
    entries.sort((a, b) => Number(b.name === "SKILL.md") - Number(a.name === "SKILL.md"));
    for (const entry of entries) {
      if (files.length >= extensionSkillLimits.files) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join("/");
      if (name.length > extensionSkillLimits.path) continue;
      if (entry.isDirectory()) { await walk(path, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const text = await textOf(path, extensionSkillLimits.totalBytes - bytes);
      if (text === undefined) continue;
      bytes += Buffer.byteLength(text);
      files.push({ path: name, text });
    }
  };
  await walk(root, 0);
  return files;
}

export async function collectSkills(paths: readonly string[], scratch: string = tmpdir()): Promise<ExtensionSkill[]> {
  if (!paths.length) return [];
  const { skills } = loadSkills({ cwd: scratch, agentDir: join(scratch, "pikibun-no-agent-dir"), skillPaths: [...paths], includeDefaults: false });
  const temporary = await realpath(tmpdir()).catch(() => tmpdir());
  const collected: ExtensionSkill[] = [];
  for (const skill of skills) {
    if (collected.length >= extensionSkillLimits.skills) break;
    if (typeof skill.description !== "string" || !skill.description.trim()) continue;
    const declared = basename(skill.filePath) === "SKILL.md";
    const base = await realpath(skill.baseDir).catch(() => undefined);
    const real = await realpath(skill.filePath).catch(() => undefined);
    if (!base || !real || !inside(base, real) || relative(base, real).split(sep).includes(".git")) continue;
    if (declared && (base === temporary || base === sep)) continue;
    const file = relative(base, real).split(sep).join("/");
    let files: ExtensionSkillFile[];
    if (declared) files = await folderFiles(base);
    else {
      const text = await textOf(real, extensionSkillLimits.totalBytes);
      files = text === undefined ? [] : [{ path: file, text }];
    }
    if (!files.some(item => item.path === file)) continue;
    collected.push({ name: skill.name, description: skill.description, disableModelInvocation: skill.disableModelInvocation === true, file, files });
  }
  return collected;
}
