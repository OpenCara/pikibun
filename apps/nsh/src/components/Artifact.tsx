import { effect, Image, signal, Text, View, WebView } from "nsh";
import { TextView } from "nsh/base";
import { artifactFrame, type ArtifactKind, type ArtifactRef } from "../../../../packages/shared/src/artifacts";
import { errorMessage, formatBytes, REDACTED, type ArtifactContent, type ArtifactSource } from "../shared";
import { relativeTime } from "../lib/format";
import { openMessageLink } from "../lib/links";
import { Icon, type IconName } from "../icons";
import { palette, radius, text } from "../theme";
import { Badge, Banner, Button, Small } from "../ui";
import { CodeView } from "../session-panel/Files";

export const artifactKindLabels: Record<ArtifactKind, string> = { html: "HTML", svg: "SVG", markdown: "Markdown", text: "Text" };
const kindIcons: Record<ArtifactKind, IconName> = { html: "globe", svg: "image", markdown: "file", text: "file" };

function Frame(props: { kind: "html" | "svg"; content: string; height: number }) {
  const unavailable = signal(false);
  return (
    <If when={!unavailable()} else={
      <View style={{ gap: 8 }}>
        <Small>This app can't show web pages here, so this is the artifact's source.</Small>
        <CodeView text={props.content} path={props.kind === "svg" ? "artifact.svg" : "artifact.html"} />
      </View>
    }>
      <View style={{ height: props.height, overflow: "hidden", borderRadius: radius.medium, borderWidth: 1, borderColor: palette().border, backgroundColor: "#ffffff" }}>
        <WebView testID="artifact-frame" html={artifactFrame(props.kind, props.content)} incognito style={{ flex: 1 }}
          onError={event => { if (event.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" || event.code === "ERR_ACCESS_DENIED") unavailable.set(true); }} />
      </View>
    </If>
  );
}

export function ArtifactBody(props: { artifact: ArtifactContent; height?: number }) {
  const kind = () => props.artifact.kind;
  return (
    <View style={{ gap: 8 }}>
      <If when={props.artifact.redacted}>
        <Banner title="Secret hidden">{`Something that looks like a secret is shown as ${REDACTED}, as in the conversation.`}</Banner>
      </If>
      <If when={kind() === "html" || kind() === "svg"}>
        <Frame kind={kind() as "html" | "svg"} content={props.artifact.content} height={props.height ?? 360} />
      </If>
      <If when={kind() === "markdown"}>
        <TextView testID="artifact-markdown" markdown={props.artifact.content} options={{ html: false, mdx: false }} selectable
          onLinkPress={event => openMessageLink(event.url)}
          renderImage={image => (image.src.startsWith("data:image/")
            ? <Image src={image.src} accessibilityLabel={image.alt ?? ""} style={{ maxWidth: "100%", height: 200, objectFit: "contain" }} />
            : <Text style={{ fontSize: text.small, color: palette().muted }}>{`[image${image.alt ? `: ${image.alt}` : ""}]`}</Text>)} />
      </If>
      <If when={kind() === "text"}>
        <CodeView text={props.artifact.content} />
      </If>
    </View>
  );
}

export function ArtifactViewer(props: { source: ArtifactSource; name: string; version: number; height?: number }) {
  const artifact = signal<ArtifactContent | null>(null);
  const error = signal("");
  const attempt = signal(0);
  effect(() => {
    const { name, version } = props;
    attempt();
    let live = true;
    artifact.set(null);
    error.set("");
    props.source.read(name, version).then(result => { if (live) artifact.set(result.artifact); }, reason => { if (live) error.set(errorMessage(reason)); });
    return () => { live = false; };
  });
  return (
    <If when={!error()} else={
      <Banner tone="danger" title="Can't show this artifact" actions={<Button small variant="outline" label="Try again" onPress={() => attempt.update(value => value + 1)} />}>{error()}</Banner>
    }>
      <If when={artifact()} else={<Small>Loading artifact…</Small>}>
        {current => (
          <View style={{ gap: 8 }}>
            <Small>{`${artifactKindLabels[current().kind]} · ${formatBytes(current().size)} · ${relativeTime(current().createdAt)}`}</Small>
            <ArtifactBody artifact={current()} height={props.height} />
          </View>
        )}
      </If>
    </If>
  );
}

export function ArtifactCard(props: { reference: ArtifactRef; source?: ArtifactSource }) {
  const open = signal(false);
  const reference = () => props.reference;
  return (
    <View testID={`artifact-card-${reference().name}-${reference().version}`} style={{ gap: 10, padding: 12, borderRadius: radius.medium, borderWidth: 1,
      borderColor: palette().border, backgroundColor: palette().surfaceRaised }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Icon name={kindIcons[reference().kind]} size={18} color={palette().muted} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ numberOfLines: 1, fontSize: text.body, color: palette().text }}>{reference().title ?? reference().name}</Text>
          <Text style={{ numberOfLines: 1, fontSize: text.caption, color: palette().muted }}>{`${reference().name} · version ${reference().version}`}</Text>
        </View>
        <Badge>{artifactKindLabels[reference().kind]}</Badge>
        <If when={props.source}>
          <Button small variant="outline" label={open() ? "Hide" : "Show"} onPress={() => open.update(value => !value)} />
        </If>
      </View>
      <If when={open() ? props.source : undefined}>
        {source => <ArtifactViewer source={source()} name={reference().name} version={reference().version} />}
      </If>
    </View>
  );
}
