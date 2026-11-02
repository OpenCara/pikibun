<p align="center"><img src="docs/images/pikibun-icon.png" alt="Pikibun's icon: a round cream and lavender creature with maple-seed ears, floating on a night-sky tile" width="160" height="160"></p>

# Pikibun

Run [Pi](https://github.com/earendil-works/pi) coding agents on your own machines and work on them together with your team. Pikibun is a self-hosted control plane: a web app (with iPhone, iPad, Mac and Windows apps), a Node.js server, and the `pikibun` connector that each host runs to offer its local Pi to a workspace.

Two things set it apart:

- **One subscription, the whole team.** Pair a machine where Pi is signed in to your model provider, share it with a workspace, and every teammate can start their own sessions on its models. They never see its API keys or subscription login: those stay on the host. Each session still runs as the member who started it, with their own Git accounts, so the team shares the models and not each other's identities. See [Sharing a host](docs/hosts.md#sharing-a-host).
- **Share a chat session, with exactly the permissions you choose.** Every session is a live conversation teammates can follow. Make it visible to the workspace or keep it private (the workspace's owner and admins still manage it), then give people exactly what they need: `read` to watch, `ask` for side questions that don't touch the work, `write` to drive it, `approve` to decide its commands and pushes, `manage` to share it further. A read-only link can show the conversation to anyone, even without signing in. See [Collaborating on a session](docs/collaboration.md).

<p align="center">
  <img src="docs/images/team-collaboration.svg" alt="Alice shares her host, where Pi is signed in to a model provider, with the workspace. Bob starts a session on it that runs as Bob. Carol can write and approve, Dan sends side asks, Erin reads, and anyone with the share link follows the conversation read-only." width="900">
</p>

And around them:

- **Your machines, your models.** Sessions run on members' own hosts with the models and credentials configured in Pi there. A host connects over an outbound WebSocket: no inbound port or tunnel.
- **Isolated work.** Each session clones the workspace's repositories into its own sandbox, whose only way out is a proxy that reads them with the session owner's account and follows the workspace's network policy.
- **People decide.** Shell commands, commits, pushes, GitHub comments, merges and new issues wait for an approval unless the session owner auto-approves a message.
- **Built for teams.** Workspace roles (viewer, member, collaborator, admin) set what each person can do by default, with the workspace's owner and admins managing every session in it, and session grants add more for one session at a time.

## Quick start

Just for yourself, on one computer:

```sh
npx pikibun@latest serve
```

It runs the server, the web app and your computer as its host, at `http://127.0.0.1:7878`. See [Running Pikibun on your own computer](docs/local.md).

For a team, [run the server](docs/self-hosting.md) with Docker, then pair each member's machine as a host:

```sh
npx pikibun@latest connect --server https://pikibun.example.com --pairing-id PAIRING_ID
```

The [quick start](docs/quick-start.md) walks through it step by step.

## Documentation

- [How it works](docs/how-it-works.md): the server, hosts and the main concepts
- [Quick start](docs/quick-start.md)
- Using Pikibun
  - [Signing in and your profile](docs/accounts.md)
  - [Workspaces and members](docs/workspaces.md)
  - [Repositories and Git accounts](docs/repositories.md): repositories, document sources and workspace connections
  - [Hosts](docs/hosts.md): pairing, models, sharing, the sandbox and network access
  - [Models and tools](docs/models-and-tools.md)
  - [Extensions](docs/extensions.md)
  - [Sessions](docs/sessions.md)
  - [Approvals and permission requests](docs/approvals.md)
  - [Collaborating on a session](docs/collaboration.md)
  - [Commits, pushes and pull requests](docs/pushes.md)
  - [GitHub issues and pull requests](docs/github.md)
  - [Host commands](docs/host-commands.md)
  - [Backups, restores and moving sessions](docs/backups.md)
  - [iPhone, iPad, Mac and Windows apps](docs/apps.md)
- [Running Pikibun on your own computer](docs/local.md)
- [Running the server](docs/self-hosting.md): Docker, configuration, administration and storage
- [Development](docs/development.md): building, testing, releasing and the repository layout
- [Design notes](docs/design)

## Development

Requires Node 24 and pnpm.

```sh
pnpm install
cp apps/server/.env.example apps/server/.env   # then set the local settings in docs/development.md
pnpm dev:server                                 # API on :8787
pnpm dev                                        # web UI on :5173
```

See [Development](docs/development.md) for signing in locally, tests and releases.
