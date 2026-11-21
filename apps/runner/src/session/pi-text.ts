export interface PiText {
  substitute(content: string, args: string): string;
  frontmatter(content: string): { frontmatter: Record<string, unknown>; body: string };
}

let loading: Promise<PiText> | undefined;

export function piText(): Promise<PiText> {
  loading ??= load().catch(error => { loading = undefined; throw error; });
  return loading;
}

async function load(): Promise<PiText> {
  const at = (path: string) => new URL(path, import.meta.resolve("@earendil-works/pi-coding-agent")).href;
  const templates = await import(at("./core/prompt-templates.js")) as { parseCommandArgs(args: string): string[]; substituteArgs(content: string, args: string[]): string };
  const { parseFrontmatter } = await import(at("./utils/frontmatter.js")) as { parseFrontmatter(content: string): { frontmatter: Record<string, unknown> | null; body: string } };
  return {
    substitute: (content, args) => templates.substituteArgs(content, templates.parseCommandArgs(args)),
    frontmatter: content => {
      try {
        const parsed = parseFrontmatter(content);
        const frontmatter = parsed.frontmatter && typeof parsed.frontmatter === "object" && !Array.isArray(parsed.frontmatter) ? parsed.frontmatter : {};
        return { frontmatter, body: parsed.body };
      } catch { return { frontmatter: {}, body: content }; }
    },
  };
}
