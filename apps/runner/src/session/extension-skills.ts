import { createHash } from "node:crypto";
import type { ExtensionSkill } from "../extensions/protocol.js";
import { extensionSkillLimits } from "../extensions/skills.js";
import { NAME } from "./names.js";
import { skillDescription, type SkillItem } from "./skills.js";

export const EXTENSION_SKILLS_DIRECTORY = ".pikibun/skills";
export const EXTENSION_SKILL_COPIES = 2000;

export interface ProvidedSkills {
  source: string;
  skills: ExtensionSkill[];
}

export interface SkillFilesIo {
  write(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  read?(path: string): Promise<string>;
  list?(): Promise<string[]>;
}

export function extensionOwner(source: string): string {
  const tail = source.includes("#") ? source.slice(source.lastIndexOf("#") + 1) : source.replace(/^[a-z]+:/, "");
  const last = tail.replace(/@[^/@]*$/, "").split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  const name = last.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 40).replace(/[^A-Za-z0-9]+$/, "");
  return NAME.test(name) ? name : "extension";
}

export function skillFilePath(path: string): boolean {
  if (!path || path.length > extensionSkillLimits.path || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every(part => part && part !== "." && part !== ".." && !part.startsWith("."));
}

export interface SkillPlan {
  items: SkillItem[];
  files: Map<string, string>;
  skillFiles: Map<string, string>;
}

export function planSkills(provided: readonly ProvidedSkills[]): SkillPlan {
  const items: SkillItem[] = [];
  const files = new Map<string, string>();
  const skillFiles = new Map<string, string>();
  const owners = new Map<string, string>();
  for (const { source } of provided) {
    const owner = extensionOwner(source);
    const taken = [...owners.values()].includes(owner);
    owners.set(source, taken ? `${owner.slice(0, 33)}-${createHash("sha256").update(source).digest("hex").slice(0, 6)}` : owner);
  }
  for (const { source, skills } of provided) {
    const owner = owners.get(source)!;
    const names = new Set<string>();
    for (const skill of skills.slice(0, extensionSkillLimits.skills)) {
      if (typeof skill?.name !== "string" || !NAME.test(skill.name) || names.has(skill.name) || !skillFilePath(skill.file)) continue;
      const description = skillDescription(skill.description);
      if (!description || !Array.isArray(skill.files)) continue;
      let bytes = 0;
      const kept = skill.files.slice(0, extensionSkillLimits.files).filter(file => {
        if (typeof file?.text !== "string" || typeof file.path !== "string" || !skillFilePath(file.path)) return false;
        if (file.text.length > extensionSkillLimits.fileBytes) return false;
        const size = Buffer.byteLength(file.text);
        if (size > extensionSkillLimits.fileBytes || bytes + size > extensionSkillLimits.totalBytes) return false;
        bytes += size;
        return true;
      });
      if (!kept.some(file => file.path === skill.file)) continue;
      names.add(skill.name);
      const directory = `${EXTENSION_SKILLS_DIRECTORY}/${owner}/${skill.name}`;
      for (const file of kept) files.set(`${directory}/${file.path}`, file.text);
      const path = `${directory}/${skill.file}`;
      skillFiles.set(path, directory);
      items.push({ name: skill.name, title: skill.name, owner, path, description, listed: skill.disableModelInvocation !== true, origin: source });
    }
  }
  return { items, files, skillFiles };
}

const digest = (text: string) => createHash("sha256").update(text).digest("base64url");

export class ExtensionSkillFiles {
  readonly #written = new Map<string, string>();
  readonly #directories = new Set<string>();
  #texts: ReadonlyMap<string, string> = new Map();
  #restored = 0;
  #cleared = false;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly io: SkillFilesIo) {}

  sync(provided: readonly ProvidedSkills[]): Promise<SkillItem[]> {
    const run = this.#queue.then(() => this.#sync(provided));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  text(path: string): string | undefined {
    return this.#texts.get(path);
  }

  get restored(): number {
    return this.#restored;
  }

  async #intact(path: string, text: string): Promise<boolean> {
    if (!this.io.read) return true;
    try { return await this.io.read(path) === text; } catch { return false; }
  }

  async #sync(provided: readonly ProvidedSkills[]): Promise<SkillItem[]> {
    const plan = planSkills(provided);
    this.#texts = plan.files;
    if (!this.#cleared) {
      await this.io.remove(EXTENSION_SKILLS_DIRECTORY).catch(() => {});
      this.#cleared = true;
    }
    const failed = new Set<string>();
    for (const [path, text] of plan.files) {
      const hash = digest(text);
      const copied = this.#written.get(path) === hash;
      if (copied && await this.#intact(path, text)) continue;
      try {
        if (copied) {
          this.#restored++;
          await this.io.remove(path).catch(() => {});
        }
        await this.io.write(path, text);
        this.#written.set(path, hash);
      } catch {
        this.#written.delete(path);
        failed.add(path);
      }
    }
    const directories = new Set(plan.skillFiles.values());
    for (const directory of [...this.#directories].filter(item => !directories.has(item))) {
      await this.io.remove(directory).catch(() => {});
      this.#directories.delete(directory);
      for (const path of [...this.#written.keys()]) if (path.startsWith(`${directory}/`)) this.#written.delete(path);
    }
    for (const path of [...this.#written.keys()].filter(path => !plan.files.has(path))) {
      await this.io.remove(path).catch(() => {});
      this.#written.delete(path);
    }
    for (const directory of directories) this.#directories.add(directory);
    for (const path of await this.io.list?.().catch(() => []) ?? []) {
      if (!path.startsWith(`${EXTENSION_SKILLS_DIRECTORY}/`) || path.endsWith("/") || plan.files.has(path)) continue;
      this.#restored++;
      await this.io.remove(path).catch(() => {});
    }
    return plan.items.filter(item => !failed.has(item.path));
  }
}
