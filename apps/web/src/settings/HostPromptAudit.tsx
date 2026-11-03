import { useEffect, useRef, useState } from "react";
import type { ConnectorInfo } from "../../../../packages/shared/src/connector";
import { hostConfigLimits, type PromptAudit } from "../../../../packages/shared/src/host-config";
import { api, segment } from "../api";
import { Button, CardBody, Combobox, confirmDialog, Feedback, Row, Section, StatusBadge, useAction } from "../ui";

/*
 * The host's prompt audit (HostConfig.promptAudit): an LLM of the host's checks every message from anyone but its owner
 * before it reaches a session's agent, and refuses the ones that reach for what lies on the machine. Only the owner
 * changes it; admins see whether it is on.
 */

/** The audit model choice that means "the model the message is to run on". */
const MESSAGE_MODEL = "message";

const auditInfo = <div className="stack">
  <p>With the audit on, a model on this host reads every message that someone other than you sends to a session here before it reaches the agent: members' messages and side questions, scheduled prompts and messages from other sessions. Your own messages are never audited.</p>
  <p>It refuses messages that try to have the agent read out or send off what lies on this machine: credentials and API keys (Pi's included), your files outside the session, the machine's environment and network, or that try to get around the sandbox. A message the audit can't check, because its model fails or takes too long, is refused too. The sender sees which kind of thing was flagged. The audit's own reason is written only to the connector's log on this machine.</p>
  <p>Each audit is a request to the audit model, on your provider account. The audit is one more safeguard, not a replacement for the sandbox and approvals: it sees each message on its own, not what the agent later reads in files or tool output.</p>
</div>;

export function HostPromptAuditSection({ connector, refresh }: { connector: ConnectorInfo; refresh: () => void }) {
  const owner = connector.role !== "admin";
  const saved: PromptAudit = connector.config?.promptAudit ?? { enabled: false };
  const savedJson = JSON.stringify(saved);
  const [enabled, setEnabled] = useState(saved.enabled);
  const [model, setModel] = useState(saved.model ?? MESSAGE_MODEL);
  const [policy, setPolicy] = useState(saved.policy ?? "");
  const shown = useRef(savedJson);
  const action = useAction();
  // Status refreshes every few seconds: a setting saved meanwhile replaces the form only when it changed.
  useEffect(() => {
    if (shown.current === savedJson) return;
    shown.current = savedJson;
    const next = JSON.parse(savedJson) as PromptAudit;
    setEnabled(next.enabled); setModel(next.model ?? MESSAGE_MODEL); setPolicy(next.policy ?? "");
  }, [savedJson]);
  const current: PromptAudit = { enabled, ...(model !== MESSAGE_MODEL ? { model } : {}), ...(policy.trim() ? { policy: policy.trim() } : {}) };
  const changed = JSON.stringify(current) !== savedJson;
  const tooLong = policy.trim().length > hostConfigLimits.promptAuditPolicy;
  const editable = owner && !connector.revokedAt && !action.busy;
  const offered = connector.models.map(item => ({ value: `${item.provider}/${item.modelId}`, label: item.name, hint: `${item.provider} / ${item.modelId}` }));
  // A saved model the host no longer offers stays choosable, and the audit refuses every message until it is changed.
  const choices = [{ value: MESSAGE_MODEL, label: "The message's own model", hint: "The model the message is to run on" }, ...offered,
    ...(model !== MESSAGE_MODEL && !offered.some(item => item.value === model) ? [{ value: model, label: model, hint: "Not offered by this host now" }] : [])];

  function save() {
    void (async () => {
      if (current.enabled && !saved.enabled && !await confirmDialog({
        title: "Audit other members' messages?",
        message: `A model on ${connector.name} will check every message other people send to sessions on it, on your provider account, before it reaches the agent. Messages it flags or can't check are refused.`,
        confirmLabel: "Turn on",
      })) return;
      await action.run(async () => {
        await api(`/api/connectors/${segment(connector.id)}/config`, { method: "PATCH", body: { promptAudit: current } });
        refresh();
      }, "Prompt audit saved. Sessions on the host pick it up within a minute.");
    })();
  }

  return <Section title="Prompt audit" bare info={auditInfo}>
    <div className="card">
      <Row title="Audit other members' messages" hint={owner ? "A model on this host checks each message from someone other than you before it reaches the agent, and refuses ones that reach for this machine's secrets" : "Only the host's owner changes this"}
        trailing={owner
          ? <label className="check-row small"><input type="checkbox" className="checkbox" checked={enabled} disabled={!editable}
            onChange={event => setEnabled(event.target.checked)} /><span>Audit messages</span></label>
          : <StatusBadge tone={saved.enabled ? "success" : "neutral"}>{saved.enabled ? "On" : "Off"}</StatusBadge>} />
      {owner && enabled && <>
        <Row title="Audit model" hint="A small, fast model keeps messages quick to send. Messages with images need a model that reads images"
          trailing={<Combobox label="Audit model" value={model} disabled={!editable} options={choices} onChange={setModel} />} />
        <CardBody>
          <label className="stack">
            <span className="small">Your policy <span className="muted">(optional)</span></span>
            <textarea className="textarea" rows={4} value={policy} disabled={!editable} spellCheck={false} aria-invalid={tooLong || undefined}
              placeholder="Anything else on this host that counts as sensitive, such as: never read ~/work/clients or the database in /srv/data"
              onChange={event => setPolicy(event.target.value)} />
            <span className={`small ${tooLong ? "" : "muted"}`}>{policy.trim().length} of {hostConfigLimits.promptAuditPolicy} characters. The audit also refuses what this forbids.</span>
          </label>
        </CardBody>
      </>}
      {connector.capabilities.hostConfig && !connector.capabilities.promptAudit && <Row title="Update the host's connector"
        hint="This host's connector predates the prompt audit and runs every message unaudited until it is updated (npx pikibun@latest connect). What you save here applies then." />}
      {owner && (changed || action.error || action.notice) && <CardBody>
        <div className="stack">
          <Feedback {...action} />
          {changed && <div className="inline">
            <Button variant="default" size="sm" disabled={action.busy || tooLong} onClick={save}>Save prompt audit</Button>
            <Button variant="ghost" size="sm" disabled={action.busy} onClick={() => { setEnabled(saved.enabled); setModel(saved.model ?? MESSAGE_MODEL); setPolicy(saved.policy ?? ""); }}>Discard</Button>
          </div>}
        </div>
      </CardBody>}
    </div>
  </Section>;
}
