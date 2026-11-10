import { effect, Image, signal, Text, untracked, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import type { EntryImage, EntryImageSize } from "../../../../packages/shared/src/entry-images";
import { entryImageCaches, entryImageHref, errorMessage } from "../shared";
import { session } from "../lib/auth";
import { Icon } from "../icons";
import { ImageView } from "../session-panel/Files";
import { palette, radius, text } from "../theme";
import { Banner, Button, FormSheet } from "../ui";

const caches = entryImageCaches(href => untracked(session).api<{ image: EntryImage }>(href));

const HEIGHT = 120;

function createEntryImage(href: () => string, size: EntryImageSize) {
  const cache = caches[size];
  const source = signal<string | undefined>(undefined);
  const error = signal("");
  const attempt = signal(0);
  effect(() => {
    const current = href();
    attempt();
    let live = true;
    const loaded = cache.loaded(current);
    source.set(loaded);
    error.set("");
    if (!loaded) {
      cache.get(current).then(value => { if (live) source.set(value); }, reason => { if (live) error.set(errorMessage(reason)); });
    }
    return () => { live = false; };
  });
  return { source, error, retry: () => attempt.update(value => value + 1) };
}

const href = (sessionId: string, entryId: string, index: number, size: EntryImageSize) => entryImageHref(sessionId, entryId, index, size);

export function EntryImages(props: { sessionId: string; entryId: string; images: { mimeType: string }[]; end?: boolean }) {
  const open = signal<number | null>(null);
  const indexed = () => props.images.map((image, index) => ({ mimeType: image.mimeType, index }));
  const count = () => props.images.length;
  return (
    <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, maxWidth: "85%", alignSelf: props.end ? "flex-end" : "flex-start", justifyContent: props.end ? "flex-end" : "flex-start" }}>
        <Each of={indexed()} key={image => `${props.entryId}:${image.index}`}>
          {image => <Thumbnail href={href(props.sessionId, props.entryId, image().index, "thumbnail")} label={`Image ${image().index + 1} (${image().mimeType})`}
            onOpen={() => open.set(image().index)} />}
        </Each>
      </View>
      <FormSheet open={open() !== null} wide title={count() === 1 ? "Image" : `Image ${(open() ?? 0) + 1} of ${count()}`} onClose={() => open.set(null)}
        footer={count() > 1 ? (
          <>
            <Button small variant="outline" icon="chevron-left" label="Previous" disabled={(open() ?? 0) === 0} onPress={() => open.update(value => Math.max(0, (value ?? 0) - 1))} />
            <Button small variant="outline" icon="chevron-right" label="Next" disabled={(open() ?? 0) >= count() - 1} onPress={() => open.update(value => Math.min(count() - 1, (value ?? 0) + 1))} />
          </>
        ) : undefined}>
        <If when={open() !== null ? href(props.sessionId, props.entryId, open()!, "full") : null}>
          {whole => <WholeImage href={whole()} label={`Image ${(open() ?? 0) + 1}`} />}
        </If>
      </FormSheet>
    </>
  );
}

function Thumbnail(props: { href: string; label: string; onOpen: () => void }) {
  const image = createEntryImage(() => props.href, "thumbnail");
  const size = signal<{ width: number; height: number } | null>(null);
  effect(() => { void props.href; size.set(null); });
  const width = () => {
    const known = size();
    return known ? Math.min(HEIGHT * 2, Math.max(HEIGHT * 0.6, Math.round(HEIGHT * known.width / Math.max(1, known.height)))) : HEIGHT;
  };
  return (
    <BaseButton accessibilityLabel={image.error() ? `${props.label}: can't be shown. Try again` : `${props.label}: show it whole`}
      onPress={() => (image.error() ? image.retry() : image.source() ? props.onOpen() : undefined)}
      style={{ width: width(), height: HEIGHT, alignItems: "center", justifyContent: "center", gap: 2, overflow: "hidden", borderRadius: radius.medium, borderWidth: 1,
        borderColor: palette().border, backgroundColor: palette().surfaceRaised }}
      hoverStyle={{ borderColor: palette().borderStrong }} activeStyle={{ opacity: 0.8 }}>
      <If when={image.source()} else={
        <>
          <Icon name="image" size={20} color={palette().muted} />
          <If when={image.error()}>
            <Text style={{ fontSize: text.caption, color: palette().muted }}>Can't show</Text>
          </If>
        </>
      }>
        {source => <Image src={source()} accessibilityLabel={props.label} onLoad={event => size.set(event.size)} onError={() => image.error.set("This image couldn't be decoded.")}
          style={{ width: "100%", height: "100%", objectFit: "contain" }} />}
      </If>
    </BaseButton>
  );
}

function WholeImage(props: { href: string; label: string }) {
  const image = createEntryImage(() => props.href, "full");
  return (
    <If when={!image.error()} else={<Banner tone="danger" title="Can't show this image" actions={<Button small variant="outline" label="Try again" onPress={image.retry} />}>{image.error()}</Banner>}>
      <If when={image.source()} else={<Text style={{ fontSize: text.body, color: palette().muted, padding: 16 }}>Loading image…</Text>}>
        {source => <ImageView src={source()} path={props.label} />}
      </If>
    </If>
  );
}
