import { readFile, stat } from "fs/promises";

export function pathOfFileUrl(uri: string): string | null {
  const match = /^file:\/\/(localhost)?(\/[^?#]*)$/i.exec(uri);
  if (!match) return null;
  let path: string;
  try { path = decodeURIComponent(match[2]!); } catch { return null; }
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1).replace(/\//g, "\\") : path;
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

const types: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  heic: "image/heic", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", ico: "image/x-icon",
  pdf: "application/pdf", json: "application/json", zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  txt: "text/plain", md: "text/markdown", csv: "text/csv", html: "text/html", htm: "text/html", xml: "application/xml",
  js: "text/javascript", mjs: "text/javascript", css: "text/css", yaml: "application/yaml", yml: "application/yaml",
  mp3: "audio/mpeg", wav: "audio/wav", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};
export function typeOfName(name: string): string {
  const extension = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  return (extension && types[extension]) || "";
}

export interface LocalFiles {
  files: File[];
  tooLarge: number;
  problem: string;
}

export async function readLocalFiles(uris: readonly string[], maxBytes: number): Promise<LocalFiles> {
  const files: File[] = [];
  let tooLarge = 0;
  let problem = "";
  for (const uri of uris) {
    const path = pathOfFileUrl(uri);
    if (!path) { problem = "Only files on this computer can be attached."; continue; }
    try {
      const info = await stat(path);
      if (!info.isFile()) { problem = "Folders can't be attached: attach the files in them."; continue; }
      if (info.size > maxBytes) { tooLarge++; continue; }
      const bytes = await readFile(path);
      const name = baseName(path);
      files.push(new File([bytes as Uint8Array<ArrayBuffer>], name, { type: typeOfName(name) }));
    } catch (reason) {
      const code = (reason as { code?: string }).code;
      problem = code === "ERR_ACCESS_DENIED" ? "Only files in your home folder can be attached."
        : code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" ? "Files can't be read on this device."
        : `Couldn't read ${baseName(path)}.`;
    }
  }
  return { files, tooLarge, problem };
}
