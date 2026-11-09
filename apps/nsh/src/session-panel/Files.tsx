import { effect, Image, signal, Text, untracked, View } from "nsh";
import { fileBrowserLimits, type FileEntry, type SessionFiles, type SessionRecord } from "../../../../packages/shared/src/types";
import { REDACTED, segment } from "../shared";
import { createResource } from "../lib/resource";
import { Icon, type IconName } from "../icons";
import { monospace, palette, radius, text } from "../theme";
import { Banner, EmptyState, IconButton, ResourceState, Row, Segmented, Small } from "../ui";
import { Card } from "../settings/accounts";
import { TabPage, type PanelTabProps } from "./parts";

// The session panel's Files tab, as the web app's (session-files.tsx): the session's worktree on its host, read-only,
// one directory or file at a time, read from the host as each path is opened.

const childPath = (directory: string, name: string) => (directory === "." ? name : `${directory}/${name}`);
const parentPath = (path: string) => { const index = path.lastIndexOf("/"); return index < 0 ? "." : path.slice(0, index); };
export const filesHref = (sessionId: string, path: string) => `/api/sessions/${segment(sessionId)}/files?path=${encodeURIComponent(path)}`;

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const entryIcon: Record<FileEntry["type"], IconName> = { directory: "folder", file: "file", symlink: "link", other: "file" };

/** Why a session's files can't be shown to this person, or nothing when they can. */
export function filesUnavailable(current: SessionRecord, what: string): string | null {
  if (current.status === "archived") return `Archived sessions don't show their files. Unarchive the session to ${what}.`;
  if (!(current.permissions ?? []).includes("write")) return "Browsing the session's files takes the session collaborator role, as collaborators can already have the agent read any of them. Viewers follow the conversation.";
  return null;
}

export function Files(props: PanelTabProps) {
  const directory = signal(".");
  const file = signal<string | null>(null);
  const open = (path: string) => { directory.set(path); file.set(null); };
  return (
    <TabPage testID="panel-files">
      <If when={props.session()} else={<Small>Loading…</Small>}>
        {current => (
          <If when={!filesUnavailable(current(), "browse them")} else={<EmptyState title="Files unavailable">{filesUnavailable(current(), "browse them") ?? ""}</EmptyState>}>
            <If when={file()}
              else={<Each of={[directory()]} key={path => path}>{path => <DirectoryListing sessionId={props.sessionId} path={path()} onOpen={open} onFile={value => file.set(value)} />}</Each>}>
              {path => <Each of={[path()]} key={value => value}>{value => <FilePreview sessionId={props.sessionId} path={value()} onBack={() => file.set(null)} onDirectory={open} />}</Each>}
            </If>
          </If>
        )}
      </If>
    </TabPage>
  );
}

/** The path as links to each directory in it (.file-breadcrumbs). */
function Breadcrumbs(props: { path: string; onOpen: (path: string) => void }) {
  const parts = () => (props.path === "." ? [] : props.path.split("/"));
  const crumb = (label: string, target: string, last: boolean) => (
    <Text onPress={last ? undefined : () => props.onOpen(target)} role={last ? undefined : "link"}
      style={{ fontFamily: monospace, fontSize: text.small, color: last ? palette().text : palette().muted, textDecorationLine: last ? "none" : "underline" }}>{label}</Text>
  );
  return (
    <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 2, minWidth: 0 }}>
      {crumb("worktree", ".", parts().length === 0)}
      <Each of={parts()} key="index">
        {(part, index) => (
          <>
            <Text style={{ fontSize: text.small, color: palette().faint }}>/</Text>
            {crumb(part(), parts().slice(0, index() + 1).join("/"), index() === parts().length - 1)}
          </>
        )}
      </Each>
    </View>
  );
}

function DirectoryListing(props: { sessionId: string; path: string; onOpen: (path: string) => void; onFile: (path: string) => void }) {
  const listing = createResource<{ files: SessionFiles }>(() => filesHref(props.sessionId, props.path));
  const files = () => listing.data()?.files;
  // A symlink opened as a directory that is a file: preview it.
  effect(() => { if (files()?.type === "file") untracked(() => props.onFile(props.path)); });
  const directory = () => (files()?.type === "directory" ? files() as Extract<SessionFiles, { type: "directory" }> : null);
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Breadcrumbs path={props.path} onOpen={props.onOpen} />
        <IconButton icon="refresh" label="Refresh files" size={28} disabled={listing.loading()} onPress={listing.refresh} />
      </View>
      <ResourceState inline loading={listing.loading() && !files()} error={listing.error()} retry={listing.refresh}>
        <If when={directory()}>
          {current => (
            <If when={current().entries.length || props.path !== "."} else={<EmptyState title="The worktree is empty">The agent clones the session's repositories into it as it works.</EmptyState>}>
              <Card testID="file-list">
                <If when={props.path !== "."}>
                  <Row leading={<Icon name="chevron-left" size={16} color={palette().muted} />} title=".." hint="Parent directory" onPress={() => props.onOpen(parentPath(props.path))} />
                </If>
                <Each of={current().entries} key={entry => entry.name}>
                  {entry => (
                    <Row testID={`file-${entry().name}`} leading={<Icon name={entryIcon[entry().type]} size={16} color={palette().muted} />}
                      title={`${entry().name}${entry().type === "directory" ? "/" : ""}`}
                      hint={entry().type === "symlink" ? "Symlink" : entry().type === "other" ? "Special file" : undefined}
                      trailing={entry().size !== undefined ? formatBytes(entry().size!) : undefined}
                      onPress={entry().type === "other" ? undefined : () => (entry().type === "directory" ? props.onOpen(childPath(props.path, entry().name)) : props.onFile(childPath(props.path, entry().name)))} />
                  )}
                </Each>
                <If when={!current().entries.length}><Row title="Empty directory" /></If>
                <If when={current().truncated}><Row title={`Showing ${current().entries.length} of ${current().total} entries`} hint="Directories first, then by name" /></If>
              </Card>
            </If>
          )}
        </If>
      </ResourceState>
    </View>
  );
}

function FilePreview(props: { sessionId: string; path: string; onBack: () => void; onDirectory: (path: string) => void }) {
  const preview = createResource<{ files: SessionFiles }>(() => filesHref(props.sessionId, props.path));
  const files = () => preview.data()?.files;
  effect(() => { if (files()?.type === "directory") untracked(() => props.onDirectory(props.path)); });
  const file = () => (files()?.type === "file" ? files() as Extract<SessionFiles, { type: "file" }> : null);
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <IconButton icon="chevron-left" label="Back to directory" size={28} onPress={props.onBack} testID="file-back" />
        <Breadcrumbs path={props.path} onOpen={props.onDirectory} />
        <IconButton icon="refresh" label="Refresh file" size={28} disabled={preview.loading()} onPress={preview.refresh} />
      </View>
      <ResourceState inline loading={preview.loading() && !files()} error={preview.error()} retry={preview.refresh}>
        <If when={file()}>
          {current => (
            <View style={{ gap: 12 }}>
              <Small>{`${formatBytes(current().size)}${current().text !== undefined && current().truncated ? ` · showing the first ${formatBytes(fileBrowserLimits.textBytes)}` : ""}`}</Small>
              <If when={current().redacted}><Banner title="Secret hidden">{`Something that looks like a secret is shown as ${REDACTED}, as in the conversation.`}</Banner></If>
              <If when={current().text !== undefined}>
                <If when={current().text} else={<EmptyState title="Empty file" />}>
                  <If when={/\.svg$/i.test(props.path) && !current().truncated} else={<CodeView text={current().text ?? ""} />}>
                    <SvgPreview text={current().text ?? ""} path={props.path} />
                  </If>
                </If>
              </If>
              <If when={current().image}>{image => <ImageView src={`data:${image().mimeType};base64,${image().data}`} path={props.path} />}</If>
              <If when={current().binary}>
                <EmptyState title={current().truncated ? "Too large to preview" : "No preview"}>
                  {current().truncated ? `Images up to ${formatBytes(fileBrowserLimits.imageBytes)} are shown.` : "This isn't a text file or an image."}
                </EmptyState>
              </If>
            </View>
          )}
        </If>
      </ResourceState>
    </View>
  );
}

/** A file's text, selectable, in the code block's look. */
export function CodeView(props: { text: string }) {
  return (
    <View selectable testID="file-text" style={{ borderRadius: radius.medium, backgroundColor: palette().code, padding: 12 }}>
      <Text style={{ fontFamily: monospace, fontSize: text.small, lineHeight: 20, color: palette().text }}>{props.text}</Text>
    </View>
  );
}

/**
 * An image fit to the panel; pressing it switches to its actual size and back. Its size in pixels shows below it, and
 * one that can't be decoded says so.
 */
export function ImageView(props: { src: string; path: string }) {
  const actual = signal(false);
  const size = signal<{ width: number; height: number } | null>(null);
  const failed = signal(false);
  return (
    <If when={!failed()} else={<EmptyState title="Can't show this image">This image couldn't be decoded.</EmptyState>}>
      <View style={{ gap: 6 }}>
        <View onPress={() => actual.update(value => !value)} accessibilityLabel={actual() ? "Fit image to panel" : "Show image at actual size"}
          style={{ borderRadius: radius.medium, borderWidth: 1, borderColor: palette().border, overflow: "hidden", backgroundColor: palette().surfaceRaised }}>
          <Image src={props.src} accessibilityLabel={props.path} onLoad={event => size.set(event.size)} onError={() => failed.set(true)}
            style={actual() && size() ? { width: size()!.width, height: size()!.height } : { width: "100%", aspectRatio: size() ? size()!.width / Math.max(1, size()!.height) : 16 / 10, objectFit: "contain" }} />
        </View>
        <Small>{`${size() ? `${size()!.width} × ${size()!.height} px · ` : ""}${actual() ? "actual size · press to fit" : "fit to panel · press for actual size"}`}</Small>
      </View>
    </If>
  );
}

/** An SVG drawn as an image, or its source. */
function SvgPreview(props: { text: string; path: string }) {
  const mode = signal<"preview" | "source">("preview");
  return (
    <View style={{ gap: 8 }}>
      <Segmented small value={mode()} onChange={value => mode.set(value)} options={[{ value: "preview", label: "Preview" }, { value: "source", label: "Source" }]} />
      <If when={mode() === "preview"} else={<CodeView text={props.text} />}>
        <ImageView src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(props.text)}`} path={props.path} />
      </If>
    </View>
  );
}

