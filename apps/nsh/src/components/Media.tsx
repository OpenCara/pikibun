import { AudioPlayer, cleanup, effect, Image, signal, Text, untracked, Video, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { mediaLimits, mediaType, type MediaKind } from "../../../../packages/shared/src/media";
import { errorMessage, segment } from "../shared";
import { session } from "../lib/auth";
import { inTerminal } from "../lib/terminal";
import { Icon, type IconName } from "../icons";
import { ImageView } from "../session-panel/Files";
import { palette, radius, text } from "../theme";
import { FormSheet } from "../ui";

export interface MediaLink {
  url: string;
  path: string;
  kind: MediaKind;
  mimeType: string;
  expiresAt: number;
}

const REFRESH_MS = 5 * 60 * 1000;
const links = new Map<string, { expiresAt: number; value: Promise<MediaLink> }>();

export function mediaLink(sessionId: string, path: string): Promise<MediaLink> {
  const current = untracked(session);
  const key = `${current.origin}\n${current.user.id}\n${sessionId}\n${path}`;
  const cached = links.get(key);
  if (cached && cached.expiresAt - Date.now() > REFRESH_MS) return cached.value;
  const value = current.api<{ media: MediaLink }>(`/api/sessions/${segment(sessionId)}/media`, { method: "POST", body: { path } })
    .then(({ media }) => ({ ...media, url: new URL(media.url, current.origin).href }));
  const entry = { expiresAt: Date.now() + mediaLimits.linkSeconds * 1000, value };
  links.set(key, entry);
  value.then(media => { entry.expiresAt = media.expiresAt; }, () => { if (links.get(key) === entry) links.delete(key); });
  return value;
}

const kindIcons: Record<MediaKind, IconName> = { image: "image", video: "video", audio: "music" };
const kindLabels: Record<MediaKind, string> = { image: "Image", video: "Video", audio: "Audio" };

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

function MediaChip(props: { kind: MediaKind; path: string; note?: string; onRetry?: () => void }) {
  return (
    <View testID="media-chip" style={{ flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", maxWidth: "100%", paddingVertical: 8, paddingHorizontal: 12,
      borderRadius: radius.medium, borderWidth: 1, borderColor: palette().border, backgroundColor: palette().surfaceRaised }}>
      <Icon name={kindIcons[props.kind]} size={16} color={palette().muted} />
      <View style={{ flexShrink: 1, gap: 2 }}>
        <Text style={{ fontSize: text.small, color: palette().text, numberOfLines: 1 }}>{props.path}</Text>
        <If when={props.note}>{note => <Text style={{ fontSize: text.caption, color: palette().muted }}>{note()}</Text>}</If>
      </View>
      <If when={props.onRetry}>
        {retry => (
          <BaseButton accessibilityLabel={`Try showing ${fileName(props.path)} again`} onPress={() => retry()()} hitSlop={8}
            style={{ padding: 4, borderRadius: radius.small }} hoverStyle={{ backgroundColor: palette().hover }} activeStyle={{ opacity: 0.6 }}>
            <Icon name="refresh" size={14} color={palette().muted} />
          </BaseButton>
        )}
      </If>
    </View>
  );
}

export function WorktreeMedia(props: { sessionId?: string; path: string; alt?: string }) {
  const type = () => mediaType(props.path);
  const link = signal<MediaLink | null>(null);
  const error = signal("");
  const attempt = signal(0);
  effect(() => {
    const sessionId = props.sessionId;
    const path = props.path;
    attempt();
    let live = true;
    link.set(null);
    error.set("");
    if (sessionId === undefined || !mediaType(path)) return;
    mediaLink(sessionId, path).then(value => { if (live) link.set(value); }, reason => { if (live) error.set(errorMessage(reason)); });
    return () => { live = false; };
  });
  const failed = (message: string) => error.set(message);
  const retry = () => attempt.update(value => value + 1);
  return (
    <If when={type()} else={<MediaChip kind="image" path={props.path} note="This file can't be shown in the chat." />}>
      {known => (
        <If when={props.sessionId !== undefined} else={<MediaChip kind={known().kind} path={props.path} note={`${kindLabels[known().kind]} in the session's worktree`} />}>
          <If when={!(inTerminal && known().kind !== "image")} else={<MediaChip kind={known().kind} path={props.path} note="Open the app to play it." />}>
            <If when={!error()} else={<MediaChip kind={known().kind} path={props.path} note={error()} onRetry={retry} />}>
              <If when={link()} else={<MediaChip kind={known().kind} path={props.path} note="Loading…" />}>
                {current => (
                  <>
                    <If when={current().kind === "image"}><ImageMedia link={current()} alt={props.alt} onError={failed} /></If>
                    <If when={current().kind === "video"}><VideoMedia link={current()} alt={props.alt} onError={failed} /></If>
                    <If when={current().kind === "audio"}><AudioMedia link={current()} alt={props.alt} onError={failed} /></If>
                  </>
                )}
              </If>
            </If>
          </If>
        </If>
      )}
    </If>
  );
}

export function RemoteImage(props: { src: string; alt?: string }) {
  const failed = signal(inTerminal);
  effect(() => { void props.src; failed.set(inTerminal); });
  return (
    <If when={!failed()} else={<Text style={{ fontSize: text.small, color: palette().muted }}>{`[image${props.alt ? `: ${props.alt}` : ""}]`}</Text>}>
      <Image src={props.src} accessibilityLabel={props.alt ?? ""} onError={() => failed.set(true)} style={{ width: 360, maxWidth: "100%", height: 240, objectFit: "contain" }} />
    </If>
  );
}

function Caption(props: { text?: string }) {
  return <If when={props.text}>{caption => <Text style={{ fontSize: text.caption, color: palette().muted }}>{caption()}</Text>}</If>;
}

function ImageMedia(props: { link: MediaLink; alt?: string; onError: (message: string) => void }) {
  const open = signal(false);
  const label = () => props.alt || fileName(props.link.path);
  return (
    <View style={{ gap: 4, alignSelf: "flex-start", maxWidth: "100%" }}>
      <BaseButton testID="media-image" accessibilityLabel={`${label()}: show it whole`} onPress={() => open.set(true)}
        style={{ maxWidth: "100%", borderRadius: radius.medium, overflow: "hidden", borderWidth: 1, borderColor: palette().border, backgroundColor: palette().surfaceRaised }}
        hoverStyle={{ borderColor: palette().borderStrong }} activeStyle={{ opacity: 0.85 }}>
        <Image src={props.link.url} accessibilityLabel={label()} onError={() => props.onError("This image couldn't be loaded.")}
          style={{ width: 360, maxWidth: "100%", height: 240, objectFit: "contain" }} />
      </BaseButton>
      <Caption text={props.alt} />
      <FormSheet open={open()} wide title={label()} onClose={() => open.set(false)}>
        <ImageView src={props.link.url} path={props.link.path} />
      </FormSheet>
    </View>
  );
}

function VideoMedia(props: { link: MediaLink; alt?: string; onError: (message: string) => void }) {
  const ratio = signal(16 / 9);
  return (
    <View style={{ gap: 4, width: 480, maxWidth: "100%", alignSelf: "flex-start" }}>
      <View style={{ width: "100%", aspectRatio: ratio(), borderRadius: radius.medium, overflow: "hidden", backgroundColor: "#000000" }}>
        <Video testID="media-video" src={props.link.url} controls paused accessibilityLabel={props.alt || fileName(props.link.path)}
          onLoad={event => { if (event.size.width > 0 && event.size.height > 0) ratio.set(Math.min(3, Math.max(0.5, event.size.width / event.size.height))); }}
          onError={event => props.onError(event.code === "ERR_ACCESS_DENIED" ? "This app isn't allowed to load this video." : "This video couldn't be played.")}
          style={{ width: "100%", height: "100%" }} />
      </View>
      <Caption text={props.alt || fileName(props.link.path)} />
    </View>
  );
}

function AudioMedia(props: { link: MediaLink; alt?: string; onError: (message: string) => void }) {
  const state = signal<"idle" | "loading" | "playing" | "paused" | "ended">("idle");
  const position = signal(0);
  const duration = signal(Number.NaN);
  let player: AudioPlayer | undefined;
  const release = () => {
    const current = player;
    player = undefined;
    try { current?.dispose(); } catch { }
  };
  cleanup(release);
  effect(() => {
    void props.link.url;
    release();
    state.set("idle");
    position.set(0);
    duration.set(Number.NaN);
  });
  function start(): AudioPlayer | undefined {
    if (player) return player;
    try {
      const created = new AudioPlayer(props.link.url);
      created.on("load", load => duration.set(load.duration));
      created.on("progress", progress => { position.set(progress.currentTime); if (Number.isFinite(progress.duration)) duration.set(progress.duration); });
      created.on("buffer", buffer => { if (buffer.buffering) state.set("loading"); else if (created.state === "playing") state.set("playing"); });
      created.on("end", () => { state.set("ended"); position.set(0); });
      created.on("error", failure => { release(); state.set("idle"); props.onError(failure.message || "This audio couldn't be played."); });
      player = created;
      return created;
    } catch (reason) {
      props.onError(errorMessage(reason));
      return undefined;
    }
  }
  function toggle() {
    if (state() === "playing" || state() === "loading") {
      player?.pause();
      state.set("paused");
      return;
    }
    const current = start();
    if (!current) return;
    if (state() === "ended") current.seek(0);
    state.set("loading");
    current.play().then(() => { if (player === current) state.set("playing"); }, reason => {
      if (player !== current) return;
      state.set("idle");
      props.onError(errorMessage(reason));
    });
  }
  const playing = () => state() === "playing" || state() === "loading";
  const fraction = () => (Number.isFinite(duration()) && duration() > 0 ? Math.min(1, position() / duration()) : 0);
  const label = () => props.alt || fileName(props.link.path);
  return (
    <View testID="media-audio" style={{ flexDirection: "row", alignItems: "center", gap: 10, width: 360, maxWidth: "100%", alignSelf: "flex-start", padding: 10,
      borderRadius: radius.medium, borderWidth: 1, borderColor: palette().border, backgroundColor: palette().surfaceRaised }}>
      <BaseButton testID="media-audio-toggle" accessibilityLabel={playing() ? `Pause ${label()}` : `Play ${label()}`} onPress={toggle}
        style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: 18, backgroundColor: palette().primary }}
        activeStyle={{ opacity: 0.8 }}>
        <Icon name={playing() ? "pause" : "play"} size={16} color={palette().onPrimary} />
      </BaseButton>
      <View style={{ flex: 1, gap: 6 }}>
        <Text style={{ fontSize: text.small, color: palette().text, numberOfLines: 1 }}>{label()}</Text>
        <View style={{ height: 4, borderRadius: 2, backgroundColor: palette().border, overflow: "hidden" }}>
          <View style={{ width: `${Math.round(fraction() * 1000) / 10}%`, height: 4, backgroundColor: palette().primary }} />
        </View>
      </View>
      <Text style={{ fontSize: text.caption, color: palette().muted }}>{`${formatTime(position())} / ${formatTime(duration())}`}</Text>
    </View>
  );
}
