import type { PullRequestFileStatus, PullRequestFileView } from "./types.js";

export const pullRequestFileStatusLabels: Record<PullRequestFileStatus, string> = {
  added: "Added",
  modified: "Modified",
  removed: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
};

export function filePatch(file: Pick<PullRequestFileView, "path" | "previousPath" | "status" | "patch">): string | null {
  if (!file.patch) return null;
  const previous = file.previousPath ?? file.path;
  const lines = [`diff --git a/${previous} b/${file.path}`];
  if (file.status === "added") lines.push("new file mode 100644");
  if (file.status === "removed") lines.push("deleted file mode 100644");
  if (file.status === "renamed" && file.previousPath) lines.push(`rename from ${file.previousPath}`, `rename to ${file.path}`);
  if (file.status === "copied" && file.previousPath) lines.push(`copy from ${file.previousPath}`, `copy to ${file.path}`);
  lines.push(file.status === "added" ? "--- /dev/null" : `--- a/${previous}`, file.status === "removed" ? "+++ /dev/null" : `+++ b/${file.path}`);
  return `${lines.join("\n")}\n${file.patch.replace(/\n$/, "")}\n`;
}

export interface ReviewTreeNode {
  id: string;
  label: string;
  path: string;
  file?: PullRequestFileView;
  children?: ReviewTreeNode[];
  files?: number;
}

export const reviewFileId = (path: string) => `file:${path}`;
export const reviewDirectoryId = (path: string) => `dir:${path}`;

interface Directory { directories: Map<string, Directory>; files: PullRequestFileView[] }

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const byName = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);

export function reviewTree(files: readonly PullRequestFileView[], grouped = true): ReviewTreeNode[] {
  const leaf = (file: PullRequestFileView, label: string): ReviewTreeNode => ({ id: reviewFileId(file.path), label, path: file.path, file });
  if (!grouped) return [...files].sort((a, b) => byName(baseName(a.path), baseName(b.path)) || byName(a.path, b.path)).map(file => leaf(file, baseName(file.path)));
  const root: Directory = { directories: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      let next = directory.directories.get(part);
      if (!next) { next = { directories: new Map(), files: [] }; directory.directories.set(part, next); }
      directory = next;
    }
    directory.files.push(file);
  }
  const build = (directory: Directory, prefix: string): { nodes: ReviewTreeNode[]; files: number } => {
    const nodes: ReviewTreeNode[] = [];
    let total = directory.files.length;
    for (const name of [...directory.directories.keys()].sort(byName)) {
      let label = name;
      let path = prefix ? `${prefix}/${name}` : name;
      let current = directory.directories.get(name)!;
      while (current.files.length === 0 && current.directories.size === 1) {
        const [childName, child] = [...current.directories.entries()][0]!;
        label = `${label}/${childName}`;
        path = `${path}/${childName}`;
        current = child;
      }
      const built = build(current, path);
      total += built.files;
      nodes.push({ id: reviewDirectoryId(path), label, path, children: built.nodes, files: built.files });
    }
    for (const file of [...directory.files].sort((a, b) => byName(baseName(a.path), baseName(b.path)))) nodes.push(leaf(file, baseName(file.path)));
    return { nodes, files: total };
  };
  return build(root, "").nodes;
}

export function reviewDirectoryIds(nodes: readonly ReviewTreeNode[]): string[] {
  return nodes.flatMap(node => (node.children ? [node.id, ...reviewDirectoryIds(node.children)] : []));
}

export function reviewFileOrder(nodes: readonly ReviewTreeNode[]): string[] {
  return nodes.flatMap(node => (node.children ? reviewFileOrder(node.children) : [node.path]));
}
