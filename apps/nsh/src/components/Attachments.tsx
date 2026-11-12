import { Image, platform, Text, View } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { formatBytes } from "../../../../packages/shared/src/file-uploads";
import type { Attachments } from "../lib/attachments";
import { pageAvailable } from "../lib/page";
import { Icon } from "../icons";
import { palette, radius, text } from "../theme";
import { DropdownMenu, IconButton } from "../ui";

function RemoveButton(props: { label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <BaseButton accessibilityLabel={props.label} disabled={props.disabled} onPress={props.onPress} hitSlop={6}
      style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center",
        backgroundColor: palette().control, borderWidth: 1, borderColor: palette().borderStrong }}
      hoverStyle={{ backgroundColor: palette().hoverStrong }} activeStyle={{ opacity: 0.7 }} disabledStyle={{ opacity: 0.5 }}>
      <Icon name="x" size={12} color={palette().text} />
    </BaseButton>
  );
}

export function AttachmentStrip(props: { attachments: Attachments; disabled?: boolean }) {
  const status = (id: string, size: number, uploaded: boolean) => {
    const sent = props.attachments.progress()[id];
    return uploaded ? "Uploaded" : sent !== undefined && size ? `Uploading ${Math.floor(sent / size * 100)}%` : formatBytes(size);
  };
  return (
    <If when={props.attachments.count() > 0}>
      <View testID="composer-attachments" accessibilityLabel="Attachments" style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, paddingTop: 6, paddingRight: 6 }}>
        <Each of={props.attachments.images()} key={item => item.id}>
          {(item, index) => (
            <View testID={`attachment-image-${index()}`} style={{ width: 56, height: 56 }}>
              <Image src={item().url} accessibilityLabel={`Image ${index() + 1}`}
                style={{ width: 56, height: 56, borderRadius: radius.medium, borderWidth: 1, borderColor: palette().border, objectFit: "cover" }} />
              <RemoveButton label={`Remove image ${index() + 1}`} disabled={props.disabled} onPress={() => props.attachments.remove(item().id)} />
            </View>
          )}
        </Each>
        <Each of={props.attachments.files()} key={item => item.id}>
          {item => (
            <View testID="attachment-file" style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 44, maxWidth: 240, paddingLeft: 10, paddingRight: 14,
              borderRadius: radius.medium, borderWidth: 1, borderColor: palette().border, backgroundColor: palette().background }}>
              <Icon name="file" size={16} color={palette().muted} />
              <View style={{ flexShrink: 1 }}>
                <Text style={{ numberOfLines: 1, fontSize: text.small, color: palette().text }}>{item().name}</Text>
                <Text style={{ numberOfLines: 1, fontSize: text.caption, color: palette().muted }}>{status(item().id, item().file.size, Boolean(item().uploaded))}</Text>
              </View>
              <RemoveButton label={`Remove ${item().name}`} disabled={props.disabled} onPress={() => props.attachments.remove(item().id)} />
            </View>
          )}
        </Each>
      </View>
    </If>
  );
}

export function AttachButton(props: { attachments: Attachments; disabled?: boolean }) {
  const files = () => props.attachments.takesFiles();
  const choose = () => files() && !pageAvailable() && !platform.desktop;
  return (
    <If when={choose()} else={
      <IconButton testID="composer-attach" icon={files() ? "paperclip" : "image"} label={files() ? "Attach files" : "Attach images"} disabled={props.disabled}
        onPress={() => void props.attachments.pick()} />
    }>
      <DropdownMenu label="Attach" placement="top" items={[
        { label: "Photos", icon: "image", testID: "composer-attach-photos", onSelect: () => void props.attachments.pick("images") },
        { label: "Files", icon: "paperclip", testID: "composer-attach-files", onSelect: () => void props.attachments.pick("files") },
      ]} trigger={<IconButton testID="composer-attach" icon="paperclip" label="Attach photos or files" disabled={props.disabled} onPress={() => undefined} />} />
    </If>
  );
}
