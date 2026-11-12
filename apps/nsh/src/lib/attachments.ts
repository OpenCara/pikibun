import { cleanup, computed, Picker, signal, untracked, type Accessor } from "nsh";
import { chatImageLimits, type ChatImage, type ChatImageType } from "../../../../packages/shared/src/chat-images";
import { attachedFilesNote, fileUploadLimits, formatBytes, uploadFileName, type UploadChunk, type UploadResult } from "../../../../packages/shared/src/file-uploads";
import { segment, type ConnectorInfo } from "../shared";
import { session } from "./auth";
import { onClearDrafts } from "./drafts";
import { readLocalFiles, typeOfName } from "./local-files";
import { encodeImageInPage, pageAvailable, pickFilesInPage } from "./page";
import { createResource } from "./resource";

const MODEL_IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_EDGE = 1568;
const MAX_PASTE_BYTES = 32 * 1024 * 1024;

export interface PendingImage {
  id: string;
  file: Blob;
  url: string;
}

export interface UploadedFile {
  path: string;
  size: number;
}

export interface AttachedFile {
  id: string;
  file: Blob;
  name: string;
  uploaded?: UploadedFile;
}

export interface FileAttachmentOptions {
  unavailable?: string;
  maxBytes: number;
}

export function imagesUnavailable(host: ConnectorInfo | undefined): string | undefined {
  return host && !host.capabilities.chatImages ? "Update the host's connector (npx pikibun@latest connect) to send images." : undefined;
}

export function filesUnavailable(host: ConnectorInfo | undefined): string | undefined {
  return host && !host.capabilities.fileUploads ? "Update the host's connector (npx pikibun@latest connect) to attach files." : undefined;
}

export function createFileOptions(workspaceId: Accessor<string | null>, host: Accessor<ConnectorInfo | undefined>, writable: Accessor<boolean> = () => true): Accessor<FileAttachmentOptions> {
  const settings = createResource<{ settings: { maxFileBytes: number } }>(() => {
    const id = workspaceId();
    return id ? `/api/workspaces/${segment(id)}/attachments` : null;
  });
  return () => {
    const maxBytes = settings.data()?.settings.maxFileBytes ?? fileUploadLimits.defaultBytes;
    const unavailable = !writable() ? "Attaching files writes them into the session, which takes write access." : filesUnavailable(host());
    return { ...(unavailable ? { unavailable } : {}), maxBytes };
  };
}

function attachmentName(file: Blob, given?: string): string {
  const name = uploadFileName(given ?? (file as File).name ?? "");
  if (name) return name;
  const extension = /^[a-z]+\/([a-z0-9]{1,8})$/.exec(file.type)?.[1];
  return `pasted-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}${extension ? `.${extension}` : ""}`;
}

const newId = () => crypto.randomUUID();

const handedOverImages = new Map<string, Blob[]>();
const handedOverFiles = new Map<string, AttachedFile[]>();
const receivers = new Map<string, (files: Blob[]) => void>();

export function handOverAttachments(sessionId: string, images: readonly PendingImage[], files: readonly AttachedFile[]): void {
  if (images.length) handedOverImages.set(sessionId, images.map(image => image.file));
  if (files.length) handedOverFiles.set(sessionId, [...files]);
}

export function restoreImages(sessionId: string, files: readonly Blob[]): void {
  if (!files.length) return;
  const receive = receivers.get(sessionId);
  if (receive) receive([...files]);
  else handedOverImages.set(sessionId, [...(handedOverImages.get(sessionId) ?? []), ...files]);
}

onClearDrafts(() => {
  handedOverImages.clear();
  handedOverFiles.clear();
  receivers.clear();
});

export function imageBlobs(images: readonly ChatImage[]): Blob[] {
  return images.map(image => new Blob([decodeBase64(image.data)], { type: image.mimeType }));
}

export interface Attachments {
  images: Accessor<PendingImage[]>;
  files: Accessor<AttachedFile[]>;
  progress: Accessor<Record<string, number>>;
  count: Accessor<number>;
  notice: Accessor<string>;
  takesFiles: Accessor<boolean>;
  attach: (chosen: readonly Blob[]) => void;
  addImages: (chosen: readonly Blob[]) => void;
  attachLocal: (uris: readonly string[]) => Promise<void>;
  pick: (kind?: "images" | "files") => Promise<void>;
  remove: (id: string) => void;
  sent: (images: readonly PendingImage[], files: readonly AttachedFile[]) => void;
  upload: (sessionId: string, files: readonly AttachedFile[]) => Promise<string>;
}

export function createAttachments(options: { imagesUnavailable: Accessor<string | undefined>; fileOptions?: Accessor<FileAttachmentOptions>; sessionId?: string }): Attachments {
  const images = signal<PendingImage[]>([]);
  const files = signal<AttachedFile[]>([]);
  const progress = signal<Record<string, number>>({});
  const notice = signal("");
  const urls = new Set<string>();
  const image = (file: Blob): PendingImage => {
    const url = URL.createObjectURL(file);
    urls.add(url);
    return { id: newId(), file, url };
  };
  const forget = (removed: readonly PendingImage[]) => {
    for (const item of removed) {
      URL.revokeObjectURL(item.url);
      urls.delete(item.url);
    }
  };
  const takesFiles = () => Boolean(options.fileOptions && !options.fileOptions().unavailable);

  function addImages(chosen: readonly Blob[]) {
    const unavailable = untracked(options.imagesUnavailable);
    if (unavailable) { notice.set(unavailable); return; }
    const fitting = chosen.filter(file => file.size <= MAX_PASTE_BYTES);
    const room = chatImageLimits.count - untracked(images).length;
    notice.set(fitting.length < chosen.length ? "An image larger than 32 MiB can't be attached."
      : fitting.length > room ? `A message can carry at most ${chatImageLimits.count} images.` : "");
    const added = fitting.slice(0, Math.max(0, room)).map(image);
    if (added.length) images.update(previous => [...previous, ...added]);
  }

  function addFiles(chosen: readonly Blob[]) {
    const fileOptions = options.fileOptions && untracked(options.fileOptions);
    if (!fileOptions) { notice.set("Only images can be attached here."); return; }
    if (fileOptions.unavailable) { notice.set(fileOptions.unavailable); return; }
    const fitting = chosen.filter(file => file.size <= fileOptions.maxBytes);
    const room = fileUploadLimits.count - untracked(files).length;
    notice.set(fitting.length < chosen.length ? `A file larger than ${formatBytes(fileOptions.maxBytes)} can't be attached in this workspace.`
      : fitting.length > room ? `A message can carry at most ${fileUploadLimits.count} files.` : "");
    const added = fitting.slice(0, Math.max(0, room)).map(file => ({ id: newId(), file, name: attachmentName(file) }));
    if (added.length) files.update(previous => [...previous, ...added]);
  }

  function attach(chosen: readonly Blob[]) {
    const imagesOff = Boolean(untracked(options.imagesUnavailable));
    const asImages = chosen.filter(file => MODEL_IMAGE_TYPES.includes(file.type) && (!imagesOff || !untracked(takesFiles)));
    const asFiles = chosen.filter(file => !asImages.includes(file));
    if (asImages.length) addImages(asImages);
    if (asFiles.length) {
      if (!options.fileOptions && asFiles.every(file => file.type.startsWith("image/"))) addImages(asFiles);
      else addFiles(asFiles);
    }
  }

  function attachFound(found: readonly File[], maxBytes: number, anyFile: boolean, problem = "") {
    const fitting = found.filter(file => file.size <= maxBytes);
    const chosen = fitting.flatMap(file => {
      if (!MODEL_IMAGE_TYPES.includes(file.type) || base64Length(file.size) <= chatImageLimits.imageBase64) return [file];
      return anyFile ? [new File([file], file.name)] : [];
    });
    if (chosen.length) attach(chosen);
    const message = problem
      || (fitting.length < found.length ? (anyFile ? `A file larger than ${formatBytes(maxBytes)} can't be attached in this workspace.` : "An image larger than 32 MiB can't be attached.") : "")
      || (chosen.length < fitting.length ? "An image too large to send can't be attached here." : "");
    if (message) notice.set(message);
  }

  async function pick(kind?: "images" | "files") {
    notice.set("");
    const anyFile = untracked(takesFiles);
    try {
      if (pageAvailable()) {
        const maxBytes = anyFile ? untracked(options.fileOptions!).maxBytes : MAX_PASTE_BYTES;
        const picked = await pickFilesInPage({ accept: anyFile ? undefined : MODEL_IMAGE_TYPES.join(","), maxBytes });
        const tooLarge = picked.filter(item => item.data === undefined);
        const read = picked.filter(item => item.data !== undefined).map(item => new File([decodeBase64(item.data!)], item.name, { type: item.type }));
        if (read.length) attach(read);
        if (tooLarge.length) notice.set(anyFile ? `A file larger than ${formatBytes(maxBytes)} can't be attached in this workspace.` : "An image larger than 32 MiB can't be attached.");
        return;
      }
      if (anyFile && (kind ?? "files") === "files") {
        const picked = await Picker.pickFiles({ multiple: true, limit: fileUploadLimits.count + chatImageLimits.count });
        const found = picked.map(({ file }) => (file.type ? file : new File([file], file.name, { type: typeOfName(file.name) })));
        attachFound(found, untracked(options.fileOptions!).maxBytes, true);
        return;
      }
      const room = chatImageLimits.count - untracked(images).length;
      if (room <= 0) { notice.set(`A message can carry at most ${chatImageLimits.count} images.`); return; }
      const picked = await Picker.pickImages({ multiple: room > 1, limit: room, maxDimension: MAX_EDGE, quality: 0.8, format: "compatible" });
      if (picked.length) attach(picked.map(item => item.file));
    } catch (reason) {
      notice.set(reason instanceof Error ? reason.message : "Couldn't attach that.");
    }
  }

  async function attachLocal(uris: readonly string[]) {
    if (!uris.length) return;
    notice.set("");
    const anyFile = untracked(takesFiles);
    const maxBytes = anyFile ? untracked(options.fileOptions!).maxBytes : MAX_PASTE_BYTES;
    const read = await readLocalFiles(uris, maxBytes);
    attachFound(read.files, maxBytes, anyFile, read.problem
      || (read.tooLarge ? (anyFile ? `A file larger than ${formatBytes(maxBytes)} can't be attached in this workspace.` : "An image larger than 32 MiB can't be attached.") : ""));
  }

  function remove(id: string) {
    forget(untracked(images).filter(item => item.id === id));
    images.update(previous => previous.filter(item => item.id !== id));
    files.update(previous => previous.filter(item => item.id !== id));
    notice.set("");
  }

  function sent(sentImages: readonly PendingImage[], sentFiles: readonly AttachedFile[]) {
    const ids = new Set([...sentImages.map(item => item.id), ...sentFiles.map(item => item.id)]);
    forget(untracked(images).filter(item => ids.has(item.id)));
    images.update(previous => previous.filter(item => !ids.has(item.id)));
    files.update(previous => previous.filter(item => !ids.has(item.id)));
    progress.set({});
  }

  async function upload(sessionId: string, chosen: readonly AttachedFile[]): Promise<string> {
    for (const file of chosen) {
      if (file.uploaded) continue;
      file.uploaded = await uploadFile(sessionId, file.file, file.name, done => progress.update(previous => ({ ...previous, [file.id]: done })));
    }
    return attachedFilesNote(chosen.map(file => file.uploaded!));
  }

  const sessionId = options.sessionId;
  if (sessionId) {
    const kept = handedOverImages.get(sessionId);
    if (kept?.length) images.set(kept.slice(0, chatImageLimits.count).map(image));
    const keptFiles = handedOverFiles.get(sessionId);
    if (keptFiles?.length) files.set(keptFiles.slice(0, fileUploadLimits.count));
    handedOverImages.delete(sessionId);
    handedOverFiles.delete(sessionId);
    const receive = (blobs: Blob[]) => addImages(blobs);
    receivers.set(sessionId, receive);
    cleanup(() => { if (receivers.get(sessionId) === receive) receivers.delete(sessionId); });
  }
  cleanup(() => {
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  });

  return {
    images, files, progress, notice, takesFiles,
    count: computed(() => images().length + files().length),
    attach, addImages, attachLocal, pick, remove, sent, upload,
  };
}

export function withFilesNote(content: string, note: string): string {
  if (!note) return content;
  return content.trim() ? `${content}\n\n${note}` : note;
}

const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

export async function encodeImages(images: readonly PendingImage[]): Promise<ChatImage[]> {
  const budget = Math.min(chatImageLimits.imageBase64, Math.floor(chatImageLimits.totalBase64 / Math.max(1, images.length)));
  const encoded: ChatImage[] = [];
  for (const item of images) encoded.push(await encodeImage(item.file, budget));
  return encoded;
}

async function encodeImage(file: Blob, budget: number): Promise<ChatImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = signature(bytes);
  if (type && (type !== "image/webp" || !pageAvailable()) && base64Length(bytes.length) <= budget) return { mimeType: type, data: encodeBase64(bytes) };
  if (pageAvailable()) return encodeImageInPage({ data: encodeBase64(bytes), maxEdge: MAX_EDGE, budget });
  if (!type) throw new Error("An attached image can't be read. Attach a PNG, JPEG, GIF or WebP.");
  throw new Error("An attached image is too large to send. Send fewer images at once, or attach a smaller one.");
}

function signature(bytes: Uint8Array): ChatImageType | undefined {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function checked(value: UploadResult, received: number, size: number): UploadResult {
  const path = value?.path;
  if (!value || value.received !== received || (path !== undefined && (typeof path !== "string" || !/^attachments\/[^/\x00-\x1f\x7f]+$/.test(path)))
    || (received === size) !== (path !== undefined)) throw new Error("The host answered the upload unexpectedly.");
  return value;
}

export async function uploadFile(sessionId: string, file: Blob, name: string, progress?: (sent: number) => void): Promise<UploadedFile> {
  const size = file.size;
  const uploadId = newId();
  let offset = 0;
  for (;;) {
    const end = Math.min(size, offset + fileUploadLimits.chunkBytes);
    const data = encodeBase64(new Uint8Array(await file.slice(offset, end).arrayBuffer()));
    const chunk: UploadChunk = { uploadId, name, size, offset, data };
    const result = await session().api<UploadResult>(`/api/sessions/${segment(sessionId)}/uploads`, { method: "POST", body: chunk });
    checked(result, end, size);
    progress?.(end);
    if (result.path !== undefined) return { path: result.path, size };
    offset = end;
  }
}
