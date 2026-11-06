import { signal, Text } from "nsh";
import {
  accessLabels, autoApproveMerges, autoApproveWarning, CONNECTOR_UPDATE_HINT, effectiveLevel, findModel, levelLabels, modelKey, offeredLevels, selectModel,
  type AccessMode, type ChatSelection, type ConnectorInfo, type ThinkingLevel,
} from "../shared";
import type { AppData } from "../lib/app-data";
import { palette } from "../theme";
import { Chip, confirm, OptionSheet } from "../ui";

const accessIcons: Record<AccessMode, string> = { read: "👁", approval: "🛡", auto: "⚠" };

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
  const open = signal<"model" | "level" | "access" | null>(null);
  const close = () => open.set(null);
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
        <If when={host().capabilities.chatOptions} else={<Text style={{ fontSize: 13, color: palette().muted }}>{CONNECTOR_UPDATE_HINT}</Text>}>
          <Chip testID="chat-model" icon="◆" label={model()?.name ?? "Model"} disabled={!host().models.length} onPress={() => open.set("model")} />
          <If when={levels().length > 0}>
            <Chip testID="chat-reasoning" icon="✦" label={level() && levels().includes(level()!) ? levelLabels[level()!] : "Default"} onPress={() => open.set("level")} />
          </If>
          <If when={props.showAccess}>
            <Chip testID="chat-access" icon={accessIcons[props.value.access]} tone={props.value.access === "auto" ? "danger" : undefined}
              label={accessLabels[props.value.access].label} onPress={() => open.set("access")} />
          </If>
          <OptionSheet<string> open={open() === "model"} title="Model" onClose={close}
            value={props.value.model && model() ? modelKey(props.value.model) : undefined}
            options={host().models.map(item => ({ value: modelKey(item), label: item.name, hint: item.provider }))}
            onSelect={key => {
              const next = host().models.find(item => modelKey(item) === key);
              if (next) props.onChange(selectModel(props.value, next));
            }} />
          <OptionSheet<ThinkingLevel> open={open() === "level"} title="Reasoning" onClose={close} value={level()}
            options={levels().map(item => ({ value: item, label: levelLabels[item] }))}
            onSelect={thinkingLevel => props.onChange({ ...props.value, thinkingLevel })} />
          <OptionSheet<AccessMode> open={open() === "access"} title="Access" onClose={close} value={props.value.access}
            options={modes().map(mode => ({ value: mode, label: accessLabels[mode].label, hint: accessLabels[mode].hint, destructive: mode === "auto" }))}
            onSelect={access => void selectAccess(access)} />
        </If>
      )}
    </If>
  );
}
