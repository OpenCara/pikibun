import type { ExtensionFlag, ExtensionSettings } from "../../../../packages/shared/src/host-extensions";
import { Button, Field, Row } from "../ui";

/*
 * An extension's settings (its Pi flags) as a form: a check box for each boolean flag, text for each string one, and the
 * settings it no longer declares, kept until cleared. The workspace's Extensions page and the host's required extensions
 * both use it.
 */

/** The longest text a setting takes (parseExtensionSettings). */
const SETTING_TEXT = 4096;

export function ExtensionSettingsFields({ flags, settings, onChange, busy, multiline }: {
  flags: readonly ExtensionFlag[];
  settings: ExtensionSettings;
  onChange: (settings: ExtensionSettings) => void;
  busy: boolean;
  /** Flags whose text runs to several lines, such as a policy: a text area instead of one line. */
  multiline?: readonly string[];
}) {
  const known = new Set(flags.map(flag => flag.name));
  // Settings the extension no longer declares are kept, shown as they are.
  const extra = Object.keys(settings).filter(name => !known.has(name));
  const setText = (name: string, text: string) => {
    const next = { ...settings };
    if (text) next[name] = text; else delete next[name];
    onChange(next);
  };
  return <>
    {flags.map(flag => <Field key={flag.name} label={flag.name} hint={flag.description ?? (flag.default !== undefined ? `Default: ${String(flag.default)}` : undefined)}>
      {flag.type === "boolean"
        ? <label className="check-row small"><input type="checkbox" className="checkbox" disabled={busy}
          checked={(settings[flag.name] ?? flag.default) === true} onChange={event => onChange({ ...settings, [flag.name]: event.target.checked })} /><span>On</span></label>
        : multiline?.includes(flag.name)
        ? <textarea className="textarea" rows={4} disabled={busy} spellCheck={false} maxLength={SETTING_TEXT} placeholder={typeof flag.default === "string" ? flag.default : ""}
          value={typeof settings[flag.name] === "string" ? settings[flag.name] as string : ""} onChange={event => setText(flag.name, event.target.value)} />
        : <input className="input" disabled={busy} autoComplete="off" spellCheck={false} maxLength={SETTING_TEXT} placeholder={typeof flag.default === "string" ? flag.default : ""}
          value={typeof settings[flag.name] === "string" ? settings[flag.name] as string : ""} onChange={event => setText(flag.name, event.target.value)} />}
    </Field>)}
    {extra.map(name => <Row key={name} title={name} hint={`Kept: ${String(settings[name])}. The installed version doesn't declare it`}
      trailing={<Button variant="ghost" size="sm" disabled={busy} onClick={() => { const next = { ...settings }; delete next[name]; onChange(next); }}>Clear</Button>} />)}
  </>;
}
