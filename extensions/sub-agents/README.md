# Sub-agents, a Pi extension

Has the agent hand sub-tasks to sub-agents: new Pikibun sessions it starts with the `sessions` tool, each on the host that
suits its task. The Pikibun server places each one on the least loaded online host that meets its conditions (a GPU,
CPUs, memory, free memory or disk, platform, architecture, models), among the hosts the agent may start sessions on.

1. **When to delegate.** It tells the agent to split work into sub-agents where the parts are independent and can run at
   once, or where a part needs hardware or a model the session's host lacks (`delegate: when-useful`), or only when the
   person asks (`when-asked`).
2. **Where each runs.** Every `sessions create` gets the workspace's conditions (`placement`) and model preferences
   (`models`) where the agent left them out, and, with `balance` on, a placement even with no conditions, so the server
   picks the least loaded host offering the model. The agent's own conditions win.
3. **How many.** At most `max-sub-agents` per message; one more `create` is refused with why.
4. **Collecting results.** With `notify` on, each sub-agent's outcome comes back to the session when it finishes, and
   the agent is told to collect every result (`sessions wait`) and bring them together before it answers.

It registers no tool. It adds the policy to each message's system prompt (`before_agent_start`), fills in each
`sessions create` call (`tool_call`), and notes on its result where the sub-agent runs and how to collect it, or why no
host qualified (`tool_result`). The `sessions` tool's own rules still apply: the agent starts sessions only on its
sender's own hosts (and this session's host), as that sender, within the workspace's limits.

The policy is also a skill, `sub-agents`, filled in from the settings and offered through `resources_discover`. Once a
host has asked for it (Pi at startup, Pikibun before each message), the system prompt keeps only when to hand work
over, how many per message, and to read the skill before `sessions create`. A host that never asks gets the whole
policy in the prompt; with `max-sub-agents` 0 there is no skill.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `placement` | empty | Conditions for every sub-agent's host: `key=value` pairs separated by commas, such as `min_free_memory_gb=4, platform=linux`. Keys: `gpu`, `gpu_vendor`, `gpu_memory_gb`, `min_cpus`, `min_memory_gb`, `min_free_memory_gb`, `min_free_disk_gb`, `platform`, `arch`, `hosts` and `models` (lists separated by `\|`) |
| `models` | empty | Model patterns for sub-agents that name no model, separated by commas: model ids, `provider/model`, or globs such as `anthropic/*`. Any of them may run a sub-agent and load decides among them; their order only breaks ties. Empty runs them on the session's own model, on whichever host offers it |
| `balance` | on | Place every sub-agent on the least loaded qualifying host, even with no conditions |
| `max-sub-agents` | `5` | How many sub-agents one message may start, 0 to 10; 0 starts none |
| `notify` | on | Send each sub-agent's outcome back to the session that started it |
| `delegate` | `when-useful` | `when-useful` or `when-asked` |

## In Pikibun

Every connector has it built in as `piki:sub-agents`. A workspace's owners and admins add it under **Settings →
Workspaces →** the workspace **→ Extensions → Add extension → Workflows → Sub-agents**. Adding it adds **Other sessions**
(`piki:sessions`) too, whose `sessions` tool it drives; the extensions page warns while that is off. Placement needs a Pikibun server and connectors from the release
that added it; against an older server the extension leaves placement out and the agent names models instead. See
[the design](../../docs/design/host-placement.md).

## In Pi

```bash
pi install npm:@pikibun/pi-sub-agents
```

Pi has no `sessions` tool of its own, so outside Pikibun it only adds its guidance.
