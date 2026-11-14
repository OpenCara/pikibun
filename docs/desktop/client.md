# Client: use a Pikibun server from the app

As a client, the app is your window onto a Pikibun server that runs somewhere else. You start and follow sessions, share them, and manage workspaces. Sessions run on hosts: machines that you or your teammates paired with that server.

Choose this mode when:

- you use `pikibun.com`, or a server your team runs, and
- someone has shared a host with your workspace, or you'll pair a machine other than this one (a Linux server, say).

If you'd rather run sessions on this computer, set up the client first, then add [Host](host.md).

## 1. Sign in

1. Open Pikibun. At its first launch the app starts [your own Pikibun](self-host.md) on this computer; to use a server that runs elsewhere, choose **Connect to pikibun.com** or **Connect to another server** on that screen. The sign-in screen then shows the **Server** it will use.
2. To use another server (your team's, for example), choose **Change** and enter its address, such as `https://pikibun.example.com`. Addresses must use `https://`. Plain `http://` works only for `localhost` and `127.0.0.1`, which is what [Self host](self-host.md) uses.
3. Sign in with a code: sign in to the server in a browser (with GitHub, or a username and password where it offers them), choose **Settings → Profile → Signed-in apps → Sign in an app** there, then **Open in Pikibun**; or copy the link and paste it on the app's sign-in screen. The app asks before it signs in, naming the server. See [Signing in an app with a code](../accounts.md#signing-in-an-app-with-a-code).

The app has no GitHub or password sign-in of its own, and accounts can't be created in it. Create yours on the server's web page first, from the invite link you were given, then sign the app in with a code.

**Joining a team with an invite link:** open the link in your browser and sign in there. This creates your account and asks to join the workspace. An owner or admin then accepts you under **Pending members**. After that, sign in to the same server in the app, and the workspace appears in the sidebar.

Each app you sign in from is listed under **Settings → Profile → Signed-in apps**, where you can sign any of them out.

## 2. Find a host for your sessions

Sessions need a host that's online. Under **Settings → Hosts**:

- **Shared with you** lists the hosts teammates shared with your workspaces. Pick one of them, under **Host**, when you start a session in that workspace.
- **Pair a host** pairs another machine of yours (a Linux server, or WSL2) with `npx pikibun@latest connect` (see [Hosts](../hosts.md#pairing)).
- Or make this computer a host: see [Host](host.md).

## 3. Work in sessions

- **Start a session:** choose the workspace in the sidebar. Pick the model in the chat box and the **Host** in the row under it, then describe the task and press Enter. See [Sessions](../sessions.md).
- **Follow and collaborate:** a session's panel holds its details, files, browser, schedules and activity. Share it, and grant teammates `read`, `ask`, `write` or `manage` (see [Collaborating on a session](../collaboration.md)).
- **Attach files:** drop a file on the chat box, or paste one copied in your file manager.

A few things work only in a browser, at the server's web address: downloading backups and exports, and signing in to document sources (Notion, Google Drive and the like). The app shows notifications while it's open, once you turn them on under **Settings → Notifications**; to be told while it's closed, turn them on in a browser too.

## Switching between servers

The app can stay signed in to several servers (`pikibun.com`, your team's, your own [self-hosted](self-host.md) one) and shows one at a time. The server button at the bottom of the sidebar lists them, to switch with one click or **Add a server**, with **Pikibun on this Mac** for your own. **Settings → Profile → Servers** lists them too:

- **Switch** changes to another server you're signed in to. Nothing is signed out, and nothing moves between servers.
- **Add a server** opens the sign-in screen for another server: enter its address and sign in with a code. The servers you're already signed in to are listed there too, so choosing one takes you back.

If a server signed this app out meanwhile (its sign-in expired, or you signed the app out under **Signed-in apps**), switching to it says so and drops it from the list; add it again.

## Signing out

**Settings → Profile → Sign out** signs this app out of the server it shows and forgets that sign-in; the other servers stay signed in, and the sign-in screen lists them. The sign-in screen keeps the same server address, and **Change** enters another. Your sessions and workspaces stay on the server you left; nothing is moved or deleted.

If the app can't reach its server, it shows **Can't reach Pikibun** with **Try again**, **Sign out** and the other servers it is signed in to. The app shows it for your [self-hosted](self-host.md) Pikibun too, whenever that isn't running: choose **Pikibun on this Mac** there to start it, or choose **Sign out** to reach the sign-in screen's **Run Pikibun on this Mac**.
