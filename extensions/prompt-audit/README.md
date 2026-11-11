# Prompt audit, a Pi extension

Has a model check each message before it reaches the agent, and refuses one that tries to get the agent to reveal or
misuse what lies on the machine: its credentials and API keys, its owner's files outside the work, its environment and
network, or to send its data elsewhere. A message it can't check (no model, a provider error, a timeout) is refused too.

It is an ordinary [Pi package](https://github.com/earendil-works/pi): it handles Pi's `input` event and imports nothing
but Pi's own packages and Node's, so it runs in Pi as it does in Pikibun.

## In Pi

```bash
pi install npm:@opencara/pi-prompt-audit   # from npm
pi install ./extensions/prompt-audit      # from a clone of this repository
pi -e ./extensions/prompt-audit           # or for one run only
```

Its settings are Pi flags:

| Flag | Default | What it does |
|---|---|---|
| `audit` | `others` | `others` audits messages that don't come from the person at the terminal (RPC clients, other extensions); `all` audits every message |
| `audit-model` | the session's | The auditor's model, as `provider/modelId` (`--audit-model`: Pi's own `--model` sets the agent's model) |
| `model` | the session's | The same, as Pikibun's host settings name it; `audit-model` comes first |
| `policy` | none | The owner's own rules, in words, added to the auditor's instructions |

## In Pikibun

Every connector has it built in as `piki:prompt-audit`, at the connector's version: a host's owner requires it of
every session on their host (Host → Extensions), and a workspace can add it for its own sessions. There it audits every
message but the host owner's own. See [the design](../../docs/design/piki-extensions.md#the-prompt-audit-piki-prompt-audit).

A host can also run this directory as a dev extension instead (`pikibun extensions add ./extensions/prompt-audit`), to
try a change before it ships with the connector.
