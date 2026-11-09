import { readFile, stat } from "fs/promises";

// Local files a desktop hands the app as `file:` URLs: dropped on a chat box (`onFileDrop`) or copied in a file
// manager and pasted (`PasteEvent.uris`). They stand in for the browser's file chooser, which NSH's native apps lack
// (their `Picker` picks photos only). Read under the home directory capabilities.fs.read grants.

/** The local path a `file:` URL names, or null for any other URL (a network share's, say). */
export function pathOfFileUrl(uri: string): string | null {
  const match = /^file:\/\/(localhost)?(\/[^?#]*)$/i.exec(uri);
  if (!match) return null;
  let path: string;
  try { path = decodeURIComponent(match[2]!); } catch { return null; }
  // Windows: file:///C:/Users/me/a.txt names C:\Users\me\a.txt.
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1).replace(/\//g, "\\") : path;
}

/** A path's last segment. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

/** What a file is, from its extension, as a browser's file chooser types it; "" when unknown. */
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
  /** The files read, typed by their extension. */
  files: File[];
  /** How many were over `maxBytes`, and weren't read. */
  tooLarge: number;
  /** Why some couldn't be read (a folder, a file outside the home directory), or "". */
  problem: string;
}

/** Reads the regular files `uris` name, each at most `maxBytes`. */
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
