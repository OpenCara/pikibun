# Settings in two sets, and several hosts on one computer

The desktop apps (macOS, Windows, Linux) settle two things here:

1. **Settings come in two sets.** What belongs to the Pikibun server the app is signed in to (your profile, password,
   notifications, hosts as that server knows them, workspaces, administration) is listed apart from what belongs to
   this device (the hosts this computer runs, Pikibun self-hosted on it, the app's appearance). The two answer
   different questions, "what does pikibun.com know about me" and "what does this Mac do", and switching servers
   changes only the first.
2. **This computer can run several hosts.** Each is one `pikibun host --stdio` process with its own pairing, state
   directory, sandbox and models, for any server. Two hosts for `pikibun.com` on one Windows computer, one in the
   native Windows sandbox and one in WSL2's bubblewrap sandbox, are two entries; so are a Mac's host for a team's
   server and its host for `pikibun.com`.

## The two sets

`settingsSections` (`apps/nsh/src/settings/index.tsx`) gives each section a `scope`: `server` or `device`. The list
draws one group per scope under its own heading: the server's address (`pikibun.com`) above the server's sections,
and **This Mac** (**This Computer** on Windows and Linux, **This device** on phones, tablets and the web) above the
device's. On wider windows the list is Settings' own sidebar, and each page is titled with its set's heading: see
[the app's layout](app-layout.md#settings).

| Set | Sections |
| --- | --- |
| Server | Profile, Password, Notifications, Hosts, Workspaces, Administration |
| This device | Local hosts (desktops), Self host (desktops), Appearance |

The section IDs, and so the addresses (`#/settings/desktop`, `#/settings/self-host`), are unchanged; This Mac's
section is now titled **Local hosts**, since its group's heading already says whose it is, and **Hosts** under the
server stays the server's list of every host you own. Profile's **Servers** and **This app** rows stay in Profile:
they are about the accounts this app signs in with, and reach Profile from the sidebar's identity button.

## Hosts on this computer

Before, This Mac was one host per server: the first server's host used `pikibun connect`'s state directory and each
added server one named for it (`servers/<server>`), and the sandbox and the models offered were the computer's,
shared by all. A second host for the same server, or one with another sandbox, had no place.

Now each host is an entry of its own (`LocalHostConfig` in `apps/nsh/src/lib/this-computer.ts`, kept as
`pikibun.thisComputer.hosts` in the app's storage):

| Field | Meaning |
| --- | --- |
| `id` | The entry's own name, never shown: `default` for the one in the command line's state directory, else 8 random hex digits |
| `server` | The server it is paired with |
| `name` | The name it was paired with, which the server shows too |
| `sandbox` | `none` or `seatbelt` on macOS, `windows` or `wsl` on Windows, `bubblewrap` on Linux |
| `distro` | For `wsl`, the WSL distribution, or none for WSL's default |
| `stateDir` | None for the command line's (`pikibun connect`'s) state directory, else `~/.local/share/pikibun/hosts/<id>`, or `servers/<server>` for hosts made before |
| `models` | The models it offers, or none to let Pi choose |
| `connectorIds` | The host IDs it has run as, so an offline session's host can be told apart from this computer's other hosts |
| `resume` | Set while it runs, with the unsandboxed consent given, so it starts again at the next launch |

A host's process runs in an **environment**: this computer itself, or one WSL distribution. The environment, not the
host, owns what is installed and signed in there: Pikibun's command (installed and updated with the app), Pi's
configuration and its provider sign-in. So **Sign Pi in to a provider** on a WSL host's page signs in Pi inside WSL,
and every host of that distribution sees it; the models each host offers stay its own. **Install pikibun** is refused
while any host of the environment runs, since they all run the copy it replaces (on Windows, files in use are locked).
The list of WSL distributions is read once and again on **Refresh**, so a distribution set up meanwhile appears without
a restart.

- **One state directory per host.** At most one host per environment uses the command line's own state directory,
  so a computer paired from a terminal (`pikibun connect`) carries over: the page inspects that directory, and a
  pairing found there that no entry has becomes an entry. Every other host gets `hosts/<id>`. Saved entries are
  checked on load: a state directory that isn't one of those (or `servers/<server>` for its own server) is dropped,
  so nothing saved reaches a shell as a path.
- **Several hosts per server.** Each has its own pairing, so the server lists each as a host of its own, with its
  own models. A session runs on the one it was started on.
- **Sandbox per host.** It is chosen when the host is added. On macOS it can change while the host is stopped
  (`none` and `seatbelt` share an environment and a state directory); on Windows `windows` and `wsl` are different
  environments, whose state directories are on different file systems, so changing one means adding another host.
  A host changed from `seatbelt` to `none` keeps its sessions' folders, and each session's record of how it last ran
  ([a session that would leave its sandbox](local-private-sessions.md#a-session-that-would-leave-its-sandbox)): the
  consent dialog for running unsandboxed says that those sessions run on the Mac too from then on.
- **Removal.** **Remove** stops a host and forgets its entry; its pairing and sessions stay in its folder, and the
  host stays on its server, offline, until removed there. The host in the command line's state directory can't be
  removed here: its pairing is the terminal's too.

### Migration

The first launch of this version builds the list from what the app kept before: the computer's saved sandbox, models
and resume become the `default` entry (with the server it resumed for, or the one its state directory turns out to
be paired with), and each added server (`pikibun.thisComputer.servers`, with its `pikibun.thisComputer:<dir>` resume)
becomes an entry with that state directory and the computer's sandbox and models. The host IDs the app had seen per
server (`pikibun.thisComputer.connectors`) go to that server's entry; the map itself is kept, so a session that ran on
a host since removed is still recognised as this computer's. The old keys are left as they were.

### WSL

On Windows a `wsl` host runs `pikibun host --stdio` inside a WSL distribution, through `wsl.exe` (granted by name in
`nsh.json`):

```
wsl [--distribution NAME] --cd ~ --exec bash -ilc 'PATH="$HOME/.local/share/pikibun/app-cli/node_modules/.bin:$PATH"; export PATH; exec pikibun host --stdio --state-dir …'
```

- Its sessions run in WSL2's bubblewrap sandbox, with the distribution's Node.js, Pi configuration and Git, as
  `pikibun connect` run there does. Its state directory is in WSL's own file system: the connector expands `~/` itself.
- The app's copy of the command in WSL is `~/.local/share/pikibun/app-cli`, installed by **Install pikibun** on the
  host's page (`npm install --prefix "$HOME/.local/share/pikibun/app-cli" pikibun@<version>` in the same login shell),
  as the app's own `cli` folder is on the computer. The app records the version it installed per distribution and,
  after an update of the app, installs the new one there before that environment's hosts start, as it does on the
  computer. A `pikibun` installed in WSL from a terminal is never touched.
- Distribution names come from `wsl --list --quiet` and must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`; Docker
  Desktop's own distributions are left out. `wsl.exe` writes its own messages in UTF-16, so the app drops the NULs
  from what it reads; what the command inside prints is UTF-8 and passes through unchanged.
- No secret is on a command line: pairing codes and API keys go over the host's stdin, as on the computer.

### What uses the list

- **Settings → Local hosts** lists the hosts with their server, sandbox and state, starts and stops each, adds one
  (server, name, sandbox, and on Windows the WSL distribution), and opens one's page (`#/settings/desktop/<id>`):
  its pairing, sandbox, models, Pi's sign-in in its environment, prerequisites and activity, and **Remove**.
- A new session in the private workspace picks one of this computer's hosts that is online for the server.
- Reading a session from its host (`src/lib/local-sessions.ts`, [local views](local-views.md)) asks the host whose
  host ID the session names.
- **A private session whose host is offline** offers **Start host** for the entry that has run as that host ID (or
  the only entry for that server), and otherwise opens Local hosts.
