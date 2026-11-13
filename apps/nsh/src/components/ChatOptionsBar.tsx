import { Text } from "nsh";
import {
  CONNECTOR_UPDATE_HINT, effectiveLevel, findModel, levelLabels, modelKey, offeredLevels, selectModel,
  type ChatSelection, type ConnectorInfo, type ThinkingLevel,
} from "../shared";
import { AUTO } from "../lib/auto-mode";
import { palette, text } from "../theme";
import { Chip, phoneWidth, Picker } from "../ui";

const modelChipWidth = () => (phoneWidth() ? 120 : undefined);

export interface AutoModelOption {
  selected: boolean;
  onSelect: () => void;
  onLeave: () => void;
  hint: string;
  chosen?: string;
  perMessage?: boolean;
}

export function ChatOptionsBar(props: {
  host: ConnectorInfo | undefined;
  value: ChatSelection;
  onChange: (value: ChatSelection) => void;
  auto?: AutoModelOption;
}) {
  const model = () => (props.host ? findModel(props.host, props.value.model) : undefined);
  const autoSelected = () => props.auto?.selected === true;
  const modelLabel = () => {
    const name = props.auto?.chosen ?? model()?.name;
    return autoSelected() ? (name ? `Auto · ${name}` : "Auto") : model()?.name ?? "Model";
  };
  const modelOptions = (host: ConnectorInfo) => [
    ...(props.auto ? [{ value: AUTO, label: "Auto", hint: props.auto.hint, icon: "sparkles" as const }] : []),
    ...host.models.map(item => ({ value: modelKey(item), label: item.name, hint: item.provider })),
  ];
  const levels = () => offeredLevels(model());
  const level = () => effectiveLevel(model(), props.value.thinkingLevel);
  return (
    <If when={props.host}>
      {host => (
        <If when={host().capabilities.chatOptions} else={<Text style={{ fontSize: text.caption, color: palette().muted, paddingHorizontal: 8 }}>{CONNECTOR_UPDATE_HINT}</Text>}>
          <If when={host().models.length > 0} else={<Chip testID="chat-model" label={model()?.name ?? "Model"} maxWidth={modelChipWidth()} dense={phoneWidth()} disabled />}>
            <Picker<string> title="Model" value={autoSelected() ? AUTO : props.value.model && model() ? modelKey(props.value.model) : undefined}
              trigger={<Chip testID="chat-model" label={modelLabel()} icon={autoSelected() ? "sparkles" : undefined} maxWidth={modelChipWidth()} dense={phoneWidth()} />}
              options={modelOptions(host())}
              onSelect={key => {
                if (key === AUTO) { props.auto?.onSelect(); return; }
                const next = host().models.find(item => modelKey(item) === key);
                if (!next) return;
                if (autoSelected()) props.auto?.onLeave();
                props.onChange(selectModel(props.value, next));
              }} />
          </If>
          <If when={levels().length > 0 && !(autoSelected() && props.auto?.perMessage)}>
            <Picker<ThinkingLevel> title="Reasoning" value={level()}
              trigger={<Chip testID="chat-reasoning" dense={phoneWidth()} label={level() && levels().includes(level()!) ? levelLabels[level()!] : "Default"} />}
              options={levels().map(item => ({ value: item, label: levelLabels[item] }))}
              onSelect={thinkingLevel => props.onChange({ ...props.value, thinkingLevel })} />
          </If>
        </If>
      )}
    </If>
  );
}
