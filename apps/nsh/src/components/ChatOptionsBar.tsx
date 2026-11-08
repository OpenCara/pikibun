import { Text } from "nsh";
import {
  accessLabels, autoApproveMerges, autoApproveWarning, CONNECTOR_UPDATE_HINT, effectiveLevel, findModel, levelLabels, modelKey, offeredLevels, selectModel,
  type AccessMode, type ChatSelection, type ConnectorInfo, type ThinkingLevel,
} from "../shared";
import type { AppData } from "../lib/app-data";
import type { IconName } from "../icons";
import { palette, text } from "../theme";
import { Chip, confirm, Picker } from "../ui";

const accessIcons: Record<AccessMode, IconName> = { read: "eye", approval: "shield-check", auto: "zap" };

/**
 * Asks the session owner to confirm Auto-approve, with what it does on a host. A confirmed warning that names merges is
 * remembered on this device, so messages that go with Auto-approve by default don't ask again.
 */
export function confirmAutoApprove(data: AppData) {
  return async (host: ConnectorInfo, unsandboxed: boolean) => {
    const confirmed = await confirm({ title: "Auto-approve commands?", message: autoApproveWarning(host, unsandboxed), confirmLabel: "Enable auto-approve", destructive: true });
    if (confirmed && autoApproveMerges(host)) data.rememberAutoApproveConfirmed();
    return confirmed;
  };
}

/** Model, reasoning and access pickers for a chat box. Renders nothing until the host is known. */
export function ChatOptionsBar(props: {
  host: ConnectorInfo | undefined;
  value: ChatSelection;
  onChange: (value: ChatSelection) => void;
  /** Session owner: may choose auto-approve. */
  owner: boolean;
  /** Access applies to the shared conversation only, not side asks. */
  showAccess: boolean;
  unsandboxed: boolean;
  data: AppData;
}) {
  const model = () => (props.host ? findModel(props.host, props.value.model) : undefined);
  const levels = () => offeredLevels(model());
  const level = () => effectiveLevel(model(), props.value.thinkingLevel);
  const ask = confirmAutoApprove(props.data);
  async function selectAccess(access: AccessMode) {
    if (access === "auto" && props.value.access !== "auto" && props.host && !await ask(props.host, props.unsandboxed)) return;
    props.onChange({ ...props.value, access });
  }
  const modes = (): AccessMode[] => (props.owner ? ["read", "approval", "auto"] : ["read", "approval"]);
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
            <Picker<AccessMode> title="Access" value={props.value.access}
              trigger={<Chip testID="chat-access" icon={accessIcons[props.value.access]} tone={props.value.access === "auto" ? "warning" : undefined} label={accessLabels[props.value.access].label} />}
              options={modes().map(mode => ({ value: mode, label: accessLabels[mode].label, hint: accessLabels[mode].hint, destructive: mode === "auto", icon: accessIcons[mode] }))}
              onSelect={access => void selectAccess(access)} />
          </If>
        </If>
      )}
    </If>
  );
}
