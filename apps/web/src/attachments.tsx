import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { chatImageLimits, type ChatImage, type ChatImageType } from "../../../packages/shared/src/chat-images";
import type { ConnectorInfo } from "../../../packages/shared/src/connector";
import { attachedFilesNote, fileUploadLimits, formatBytes, uploadFileName } from "../../../packages/shared/src/file-uploads";
import { Icon } from "./icons";
import { segment } from "./api";
import { Button, useResource } from "./ui";
import { uploadFile, type UploadedFile } from "./uploads";
import "./attachments.css";

/** An image pasted into a composer, until its message is sent. */
export interface PastedImage {
  id: string;
  file: Blob;
}

/**
 * A file attached to a composer (anything but an image the model sees), until its message is sent: uploaded into the
 * session's worktree first, once, and the message names where it went.
 */
export interface AttachedFile {
  id: string;
  file: Blob;
  name: string;
  /** Set once it is in the worktree, so sending again doesn't upload it twice. */
  uploaded?: UploadedFile;
}

/** What a composer's host and workspace allow of attached files. */
export interface FileAttachmentOptions {
  /** Why this composer can't attach files right now (its host's connector predates them, say). */
  unavailable?: string;
  /** The workspace's limit on one file. */
  maxBytes: number;
}

/** The image types the model sees; any other file is attached as a file. */
const MODEL_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** The longest edge, in pixels, the model gets of an image (as `IMAGE_LIMITS` on the host): larger images only cost bytes. */
const MAX_EDGE = 1568;
/** Larger pastes are refused before they are decoded. */
const MAX_PASTE_BYTES = 32 * 1024 * 1024;

/**
 * Why messages to `host` can't carry images: its connector predates them. A host this reader can't see is left to the
 * server, which checks it on every message.
 */
export function imagesUnavailable(host: ConnectorInfo | undefined): string | undefined {
  return host && !host.capabilities.chatImages ? "Update the host's connector (npx pikibun@latest connect) to send images." : undefined;
}

/**
 * Why messages to `host` can't carry files: its connector predates them. A host this reader can't see is left to the
 * server, which checks it on every upload.
 */
export function filesUnavailable(host: ConnectorInfo | undefined): string | undefined {
  return host && !host.capabilities.fileUploads ? "Update the host's connector (npx pikibun@latest connect) to attach files." : undefined;
}

/** What a composer in `workspaceId`, sending to `host`, allows of attached files: the workspace's limit, the host's support. */
export function useFileAttachmentOptions(workspaceId: string, host: ConnectorInfo | undefined): FileAttachmentOptions {
  const settings = useResource<{ settings: { maxFileBytes: number } }>(`/api/workspaces/${segment(workspaceId)}/attachments`);
  const unavailable = filesUnavailable(host);
  return { ...(unavailable ? { unavailable } : {}), maxBytes: settings.data?.settings.maxFileBytes ?? fileUploadLimits.defaultBytes };
}

/** The files a paste carries, from the clipboard's items where the browser lists them there, else its files. */
function clipboardFiles(data: DataTransfer): File[] {
  const items = Array.from(data.items ?? []).filter(item => item.kind === "file")
    .map(item => item.getAsFile()).filter((file): file is File => file !== null);
  return items.length ? items : Array.from(data.files ?? []);
}

/** A file's name as the worktree takes it; a pasted screenshot or nameless blob gets one. */
function attachmentName(file: Blob): string {
  const name = file instanceof File ? uploadFileName(file.name) : "";
  if (name) return name;
  const extension = /^[a-z]+\/([a-z0-9]{1,8})$/.exec(file.type)?.[1];
  return `pasted-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}${extension ? `.${extension}` : ""}`;
}

/**
 * A composer's pasted images and attached files. `unavailable` says why this composer can't send images right now (its
 * host's connector predates them, say); a paste then only shows that. `fileOptions`, where the composer takes files,
 * says what of them it allows; images the model can't take go as files then.
 */
export function useAttachments(unavailable?: string, initial?: () => Blob[], fileOptions?: FileAttachmentOptions, initialFiles?: () => AttachedFile[]) {
  const [images, setImages] = useState<PastedImage[]>(() => (initial?.() ?? []).map(file => ({ id: crypto.randomUUID(), file })));
  const [files, setFiles] = useState<AttachedFile[]>(() => initialFiles?.() ?? []);
  /** Bytes of each file sent so far, while its message's files upload. */
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState("");
  const current = useRef(images);
  current.current = images;
  const currentFiles = useRef(files);
  currentFiles.current = files;
  function attachFiles(chosen: readonly Blob[]) {
    if (!fileOptions) { setNotice("Only images can be attached here."); return; }
    if (fileOptions.unavailable) { setNotice(fileOptions.unavailable); return; }
    const fitting = chosen.filter(file => file.size <= fileOptions.maxBytes);
    const added = fitting.map(file => ({ id: crypto.randomUUID(), file, name: attachmentName(file) }));
    const room = fileUploadLimits.count - currentFiles.current.length;
    setNotice(fitting.length < chosen.length ? `A file larger than ${formatBytes(fileOptions.maxBytes)} can't be attached in this workspace.`
      : added.length > room ? `A message can carry at most ${fileUploadLimits.count} files.` : "");
    if (added.length) setFiles(previous => [...previous, ...added].slice(0, fileUploadLimits.count));
  }
  function add(files: readonly Blob[]) {
    if (unavailable) { setNotice(unavailable); return; }
    const fitting = files.filter(file => file.size <= MAX_PASTE_BYTES);
    const added = fitting.map(file => ({ id: crypto.randomUUID(), file }));
    setNotice(fitting.length < files.length ? "An image larger than 32 MiB can't be attached."
      : current.current.length + added.length > chatImageLimits.count ? `A message can carry at most ${chatImageLimits.count} images.` : "");
    if (added.length) setImages(previous => [...previous, ...added].slice(0, chatImageLimits.count));
  }
  /**
   * Images the model sees go with the message, where its host takes them; every other file, and those images where the
   * host doesn't but takes files, is uploaded into the worktree.
   */
  function attach(chosen: readonly File[]) {
    const asImages = chosen.filter(file => MODEL_IMAGE_TYPES.includes(file.type) && (!unavailable || !fileOptions || Boolean(fileOptions.unavailable)));
    const asFiles = chosen.filter(file => !asImages.includes(file));
    if (asImages.length) add(asImages);
    if (asFiles.length) attachFiles(asFiles);
  }
  /**
   * Attaches the images and files of a paste, if any. The paste's text, when it has some (a spreadsheet's cells, a
   * copied file's name), still goes into the text box: nothing pasted is lost.
   */
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = clipboardFiles(event.clipboardData).filter(file => fileOptions || file.type.startsWith("image/"));
    if (!pasted.length) return;
    if (!event.clipboardData.types.includes("text/plain")) event.preventDefault();
    attach(pasted);
  }
  /** Attaches files chosen with a file picker (on a phone, from its photo library or camera too). */
  function pick(chosen: FileList | null) {
    const list = Array.from(chosen ?? []);
    if (!fileOptions) {
      const images = list.filter(file => file.type.startsWith("image/"));
      if (images.length) add(images);
      else if (list.length) setNotice("Only images can be attached here.");
      return;
    }
    if (list.length) attach(list);
  }
  function remove(id: string) {
    setImages(previous => previous.filter(image => image.id !== id));
    setFiles(previous => previous.filter(file => file.id !== id));
    setNotice("");
  }
  /** Removes images and files once their message was sent, keeping any attached while it was being sent. */
  function sent(images: readonly PastedImage[], files: readonly AttachedFile[] = []) {
    const ids = new Set([...images.map(image => image.id), ...files.map(file => file.id)]);
    setImages(previous => previous.filter(image => !ids.has(image.id)));
    setFiles(previous => previous.filter(file => !ids.has(file.id)));
    setProgress({});
  }
  /**
   * Uploads `files` into the session's worktree, those not uploaded yet, one after another, and answers the note their
   * message carries: where each went. A file that fails stops the rest; those already uploaded aren't sent again.
   */
  async function upload(sessionId: string, host: ConnectorInfo | undefined, files: readonly AttachedFile[]): Promise<string> {
    for (const file of files) {
      if (file.uploaded) continue;
      file.uploaded = await uploadFile(sessionId, host, file.file, file.name, sent => setProgress(previous => ({ ...previous, [file.id]: sent })));
    }
    return attachedFilesNote(files.map(file => file.uploaded!));
  }
  const count = images.length + files.length;
  return { images, files, progress, count, notice, paste, pick, remove, sent, add, upload, takesFiles: Boolean(fileOptions && !fileOptions.unavailable) };
}

/** A message's text with the note of its attached files after it; the note alone when it has no text. */
export function withFilesNote(content: string, note: string): string {
  if (!note) return content;
  return content.trim() ? `${content}\n\n${note}` : note;
}
export type Attachments = ReturnType<typeof useAttachments>;

/**
 * A button that attaches files from a file picker, for where pasting one isn't handy, as on a phone. Where the composer
 * takes only images, naming their types makes iOS hand over its photos as JPEG rather than HEIC, which messages can't
 * carry; where it takes any file, a HEIC photo goes as a file.
 */
export function AttachButton({ attachments, disabled }: { attachments: Attachments; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const label = attachments.takesFiles ? "Attach files" : "Attach images";
  return <>
    <Button variant="ghost" size="sm" icon={attachments.takesFiles ? "paperclip" : "image"} className="composer-attach" aria-label={label} title={label} disabled={disabled}
      onClick={() => input.current?.click()} />
    <input ref={input} type="file" accept={attachments.takesFiles ? undefined : MODEL_IMAGE_TYPES.join(",")} multiple hidden tabIndex={-1}
      onChange={event => { attachments.pick(event.currentTarget.files); event.currentTarget.value = ""; }} />
  </>;
}

/** Thumbnails of a composer's images and chips of its files, each with a button to remove it. */
export function AttachmentStrip({ attachments, disabled }: { attachments: Attachments; disabled?: boolean }) {
  if (!attachments.count) return null;
  return <ul className="composer-attachments" aria-label="Attachments">
    {attachments.images.map((image, index) => <li key={image.id} className="composer-attachment">
      <Thumbnail file={image.file} label={`Image ${index + 1}`} />
      <Button variant="secondary" size="xs" icon="x" className="composer-attachment-remove" aria-label={`Remove image ${index + 1}`} title="Remove image"
        disabled={disabled} onClick={() => attachments.remove(image.id)} />
    </li>)}
    {attachments.files.map(file => {
      const sent = attachments.progress[file.id];
      const status = file.uploaded ? "Uploaded" : sent !== undefined && file.file.size ? `Uploading ${Math.floor(sent / file.file.size * 100)}%` : formatBytes(file.file.size);
      return <li key={file.id} className="composer-attachment composer-file" title={file.uploaded ? `${file.uploaded.path} in the session's worktree` : file.name}>
        <Icon name="file" size={16} />
        <span className="composer-file-text">
          <span className="composer-file-name">{file.name}</span>
          <span className="composer-file-status">{status}</span>
        </span>
        <Button variant="secondary" size="xs" icon="x" className="composer-attachment-remove" aria-label={`Remove ${file.name}`} title="Remove file"
          disabled={disabled} onClick={() => attachments.remove(file.id)} />
      </li>;
    })}
  </ul>;
}

/** The object URL lives as long as the thumbnail shows it. */
function Thumbnail({ file, label }: { file: Blob; label: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const value = URL.createObjectURL(file);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  return url ? <img src={url} alt={label} /> : null;
}

/** Images a new session's first message couldn't send, kept in memory for that session's composer (as its text is). */
const handedOver = new Map<string, Blob[]>();
export function handOverImages(sessionId: string, images: readonly PastedImage[]): void {
  if (images.length) handedOver.set(sessionId, images.map(image => image.file));
}
/** Its files likewise, any already uploaded kept as such, so they aren't uploaded again. */
const handedOverFileList = new Map<string, AttachedFile[]>();
export function handOverFiles(sessionId: string, files: readonly AttachedFile[]): void {
  if (files.length) handedOverFileList.set(sessionId, [...files]);
}
export function handedOverFiles(sessionId: string): AttachedFile[] {
  return handedOverFileList.get(sessionId) ?? [];
}
/** A session's open composer, which images coming back to that session go to (see restoreImages). */
const receivers = new Map<string, (files: Blob[]) => void>();
/** While mounted, images coming back to `sessionId` are attached to `attachments`. */
export function useImageReceiver(sessionId: string, attachments: Attachments): void {
  const current = useRef(attachments);
  current.current = attachments;
  useEffect(() => {
    const receive = (files: Blob[]) => current.current.add(files);
    receivers.set(sessionId, receive);
    return () => { if (receivers.get(sessionId) === receive) receivers.delete(sessionId); };
  }, [sessionId]);
}
/**
 * Attaches images coming back to a session (a queued message taken back to edit) to its open composer, or keeps them
 * in memory for its next one, after any kept already.
 */
export function restoreImages(sessionId: string, files: readonly Blob[]): void {
  if (!files.length) return;
  const receive = receivers.get(sessionId);
  if (receive) receive([...files]);
  else handedOver.set(sessionId, [...(handedOver.get(sessionId) ?? []), ...files]);
}
/** Read when the composer starts; `forgetHandedOverImages` once it has (the start may run twice in development). */
export function handedOverImages(sessionId: string): Blob[] {
  return handedOver.get(sessionId) ?? [];
}
export function forgetHandedOverImages(sessionId: string): void {
  handedOver.delete(sessionId);
  handedOverFileList.delete(sessionId);
}

/** A message's images as its host sent them back (a queued message taken back to edit), to attach to a composer again. */
export function imageBlobs(images: readonly ChatImage[]): Blob[] {
  return images.map(image => {
    const binary = atob(image.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: image.mimeType });
  });
}

const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

/**
 * A message's images as it sends them: each within the edge the model takes and its share of the message's budget. An
 * image already within both goes as it is, so a screenshot stays exact; any other is drawn again, smaller or compressed
 * until it fits. The host prepares every image again either way.
 */
export async function encodeImages(images: readonly PastedImage[]): Promise<ChatImage[]> {
  const budget = Math.min(chatImageLimits.imageBase64, Math.floor(chatImageLimits.totalBase64 / Math.max(1, images.length)));
  const encoded: ChatImage[] = [];
  for (const image of images) encoded.push(await encodeImage(image.file, budget));
  return encoded;
}

async function encodeImage(file: Blob, budget: number): Promise<ChatImage> {
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error("A pasted image can't be read. Copy it again, or paste a PNG or JPEG."); }
  try {
    const type = await signature(file);
    // Animated WebP isn't something the host reads, so a WebP is always drawn again as a still.
    if (type && type !== "image/webp" && bitmap.width <= MAX_EDGE && bitmap.height <= MAX_EDGE && base64Length(file.size) <= budget) {
      return { mimeType: type, data: await base64(file) };
    }
    let scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 6; attempt++, scale *= 0.75) {
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      // A PNG (a screenshot, usually) stays lossless if it fits; JPEG otherwise, a little more compressed each time.
      const attempts: { mimeType: ChatImageType; quality?: number }[] = [...(type === "image/png" ? [{ mimeType: "image/png" as const }] : []),
        { mimeType: "image/jpeg", quality: 0.85 }, { mimeType: "image/jpeg", quality: 0.7 }, { mimeType: "image/jpeg", quality: 0.55 }];
      for (const { mimeType, quality } of attempts) {
        const blob = await draw(bitmap, width, height, mimeType, quality);
        if (blob && base64Length(blob.size) <= budget) return { mimeType, data: await base64(blob) };
      }
    }
    throw new Error("A pasted image is too large to send, even scaled down.");
  } finally { bitmap.close(); }
}

function draw(bitmap: ImageBitmap, width: number, height: number, mimeType: ChatImageType, quality?: number): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return Promise.resolve(null);
  // JPEG has no transparency: transparent pixels become white, as on a page, rather than black.
  if (mimeType === "image/jpeg") {
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
  }
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);
  return new Promise<Blob | null>(resolve => canvas.toBlob(resolve, mimeType, quality));
}

/** The image type a file's first bytes say it is, of those a message can carry. */
async function signature(file: Blob): Promise<ChatImageType | undefined> {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("A pasted image can't be read."));
    reader.readAsDataURL(blob);
  });
}
