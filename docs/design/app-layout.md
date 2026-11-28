# The sidebar, the main toolbar and Settings

On wider windows the app is a sidebar beside a main pane. The sidebar used to open with four rows before any
session: **New session**, **Sessions**, **Open by ID** and **Commands**. They pushed the list down, and three of them
were ways to reach things the command palette already reaches. This note says where they went and why, and how
Settings changed alongside, after two apps of the same kind: [Paseo](https://github.com/getpaseo/paseo) and
[Orca](https://github.com/stablyai/orca).

## What the two apps do

- **Paseo** keeps a few rows at the head of its sidebar (New workspace, History, Search), configurable, and fixed icons
  at its foot (Hosts, Help, Settings). Its own polish round
  ([getpaseo/paseo#5370](https://github.com/getpaseo/paseo/issues/5370)) cuts the rows down ("Search is mostly for
  discovery, since people use Cmd+K"), adds a **+** beside the sidebar's toggle so a new workspace is reachable with
  the sidebar hidden, and asks for Settings to be rethought from its information architecture: destructive actions not
  at the top, the settings sidebar keeping its scroll position. Its Settings replace the app's sidebar with their own,
  headed **Back to workspace**, in two groups (App, and Host with a host picker), and title the page with the section.
- **Orca**'s sidebar is its list of worktrees, with a Search row that opens its palette (its key shown on hover), a
  **+** in the list's section header and Settings and Help in a toolbar at its foot. Its Settings replace the sidebar
  too: **Back to app** at the top, a search over every setting (Enter opens the first result, Escape clears it),
  groups with small headings, and every project listed as its own entry, so a project's settings are one step away.

## The sidebar lists the sessions

The sidebar is the session list now: the app's name, the session search, the workspaces with their sessions (each
workspace's **+** still starts one there), and at its foot the signed-in person, the server switch and Settings.

- **New session**, **All sessions** and **Commands** are a toolbar at the top left of the main pane
  (`MainToolbar` in `apps/nsh/src/Root.tsx`): over the home, and at the start of a session's header, where they sit
  just right of where the rows were. New session shows as the current place on the home, as its row did. Its icon is
  the pen in a square chat apps use for a new conversation, apart from the **+** that starts one in a given workspace.
  On a phone, whose session list is a page of its own, its header has the same three buttons.
- **Open by ID** is a command, **Open a session by ID…**, which asks for the ID in the palette like **Rename…**
  asks for a title. A session's ID, or a link to it (`#/s/<id>`, what **Copy link** copies), pasted into the palette
  offers **Open session …** at once (`sessionIdIn` in `apps/nsh/src/lib/page.ts`). A session the list has opens
  straight away; any other goes through the Open a session page, which checks access and says why it can't open
  one. The **Sessions** page keeps its **Open by ID** button, which now opens that command.
- Keys stand in for the rows people used most: **Ctrl+Shift+O** (**⇧⌘O**) starts a new session, as in ChatGPT,
  beside **Ctrl+O** for Switch session…, and **Ctrl+,** (**⌘,**) opens Settings, as desktop apps do. A button's
  tooltip names its key, as Orca's do (`shortcut` on `IconButton`).

## Settings

On wider windows Settings take the sidebar's place (`SettingsSidebar` in `apps/nsh/src/settings/index.tsx`), so
leaving them is one row in the same spot as the app's name: **Back to app**.

- **Search** narrows the sidebar to results: each section, each setting by its title (the sections' `keywords`,
  which the palette's settings commands match too), each workspace by name, and each workspace's settings on its tabs
  (`workspaceSettings` in `apps/nsh/src/settings/search.ts`), such as **Members · Analytical Engine · Overview**.
  Return opens the first. A result opens its section, or its workspace on the right tab. The phone's list of sections
  has the same search above it.
- **Workspaces** lists each workspace under it, as Orca lists projects, so a workspace's page is one step from
  anywhere in Settings rather than two.
- The page is titled with its section and whose it is (the server, **This Mac**, or the workspace's name), as both
  apps title theirs, and the list keeps its scroll position when a row is chosen.
- A workspace's **Delete workspace** moved from its first section to a **Danger zone** at the end of its Overview tab,
  as a host's page has, since destructive actions don't belong at the top.

The two sets the settings come in, the server's and this device's, are unchanged: see
[local hosts](local-hosts.md#the-two-sets).

## Left out

- **Escape to leave Settings**, as Orca has: Escape already closes the palette, menus, sheets and dialogs over
  Settings, and an app-wide binding of it would compete with them.
- **Scrolling to the setting found**: a result opens its page at the top. Pages have no anchors to scroll to yet.
- **Configurable sidebar rows** (Paseo) and an **onboarding checklist** (Orca): the sidebar has no rows left to
  configure, and the home's first-run alerts already say what is missing.
