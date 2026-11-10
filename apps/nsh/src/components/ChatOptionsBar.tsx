import { Text } from "nsh";
import {
  accessLabels, chatAccessModes, CONNECTOR_UPDATE_HINT, effectiveLevel, findModel, levelLabels, modelKey, offeredLevels, selectModel,
  type AccessMode, type ChatSelection, type ConnectorInfo, type ThinkingLevel,
} from "../shared";
import type { IconName } from "../icons";
import { palette, text } from "../theme";
import { Chip, Picker } from "../ui";

const accessIcons: Record<AccessMode, IconName> = { read: "eye", approval: "shield-check", auto: "zap" };

export function ChatOptionsBar(props: {
  host: ConnectorInfo | undefined;
  value: ChatSelection;
  onChange: (value: ChatSelection) => void;
  showAccess: boolean;
}) {
  const model = () => (props.host ? findModel(props.host, props.value.model) : undefined);
  const levels = () => offeredLevels(model());
  const level = () => effectiveLevel(model(), props.value.thinkingLevel);
  const access = (): AccessMode => (props.value.access === "read" ? "read" : "auto");
  return (
    <If when={props.host}>
      {host => (
        <If when={host().capabilities.chatOptions} else={<Text style={{ fontSize: text.caption, color: palette().muted, paddingHorizontal: 8 }}>{CONNECTOR_UPDATE_HINT}</Text>}>
          <If when={host().models.length > 0} else={<Chip testID="chat-model" label={model()?.name ?? "Model"} disabled />}>
            <Picker<string> title="Model" value={props.value.model && model() ? modelKey(props.value.model) : undefined}
              trigger={<Chip testID="chat-model" label={model()?.name ?? "Model"} />}
              options={host().models.map(item => ({ value: modelKey(item), label: item.name, hint: item.provider }))}
              onSelect={key => {
                const next = host().models.find(item => modelKey(item) === key);
                if (next) props.onChange(selectModel(props.value, next));
              }} />
          </If>
          <If when={levels().length > 0}>
            <Picker<ThinkingLevel> title="Reasoning" value={level()}
              trigger={<Chip testID="chat-reasoning" label={level() && levels().includes(level()!) ? levelLabels[level()!] : "Default"} />}
              options={levels().map(item => ({ value: item, label: levelLabels[item] }))}
              onSelect={thinkingLevel => props.onChange({ ...props.value, thinkingLevel })} />
          </If>
          <If when={props.showAccess}>
            <Picker<AccessMode> title="Access" value={access()}
              trigger={<Chip testID="chat-access" icon={accessIcons[access()]} label={accessLabels[access()].label} />}
              options={chatAccessModes.map(mode => ({ value: mode, label: accessLabels[mode].label, hint: accessLabels[mode].hint, icon: accessIcons[mode] }))}
              onSelect={value => props.onChange({ ...props.value, access: value })} />
          </If>
        </If>
      )}
    </If>
  );
}
