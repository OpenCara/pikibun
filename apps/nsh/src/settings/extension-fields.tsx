import type { ExtensionFlag, ExtensionSettings } from "../../../../packages/shared/src/host-extensions";
import { Checkbox, Field, TextField } from "../form";
import { Button, Row } from "../ui";

const SETTING_TEXT = 4096;

export function ExtensionSettingsFields(props: {
  flags: readonly ExtensionFlag[]; settings: ExtensionSettings; onChange: (settings: ExtensionSettings) => void; busy: boolean; multiline?: readonly string[];
}) {
  const known = () => new Set(props.flags.map(flag => flag.name));
  const extra = () => Object.keys(props.settings).filter(name => !known().has(name));
  const setText = (name: string, text: string) => {
    const next = { ...props.settings };
    if (text) next[name] = text; else delete next[name];
    props.onChange(next);
  };
  const text = (name: string) => (typeof props.settings[name] === "string" ? props.settings[name] as string : "");
  return (
    <>
      <Each of={props.flags} key={flag => flag.name}>
        {flag => (
          <Field label={flag().name} hint={flag().description ?? (flag().default !== undefined ? `Default: ${String(flag().default)}` : undefined)}>
            <If when={flag().type !== "boolean"}
              else={<Checkbox label="On" disabled={props.busy} checked={(props.settings[flag().name] ?? flag().default) === true}
                onChange={checked => props.onChange({ ...props.settings, [flag().name]: checked })} />}>
              <TextField value={text(flag().name)} onChange={value => setText(flag().name, value)} disabled={props.busy} maxLength={SETTING_TEXT} monospace
                multiline={props.multiline?.includes(flag().name)} placeholder={typeof flag().default === "string" ? flag().default as string : ""} />
            </If>
          </Field>
        )}
      </Each>
      <Each of={extra()}>
        {name => (
          <Row title={name()} hint={`Kept: ${String(props.settings[name()])}. The installed version doesn't declare it`}
            trailing={<Button small variant="ghost" label="Clear" disabled={props.busy} onPress={() => { const next = { ...props.settings }; delete next[name()]; props.onChange(next); }} />} />
        )}
      </Each>
    </>
  );
}
