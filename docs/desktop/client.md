# Client: use a Pikibun server from the app

As a client, the app is your window onto a Pikibun server that runs somewhere else. You start and follow sessions, share them, and manage workspaces. Sessions run on hosts: machines that you or your teammates paired with that server.

Choose this mode when:

- you use `pikibun.com`, or a server your team runs, and
- someone has shared a host with your workspace, or you'll pair a machine other than this one (a Linux server, say).

If you'd rather run sessions on this computer, set up the client first, then add [Host](host.md).

## 1. Sign in

1. Open Pikibun. The sign-in screen shows the **Server** it will use, `pikibun.com` at first.
2. To use another server (your team's, for example), choose **Change** and enter its address, such as `https://pikibun.example.com`. Addresses must use `https://`. Plain `http://` works only for `localhost` and `127.0.0.1`, which is what [Self host](self-host.md) uses.
3. Sign in:
   - **Continue with GitHub** opens GitHub's sign-in page inside the app. When it finishes, you're back in Pikibun.
   - Or, where the server offers passwords, enter your **Username** and **Password** and choose **Sign in**.

New password accounts can't be created in the app. Create one on the server's web page first, from the invite link you were given, then sign in here.

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

A few things work only in a browser, at the server's web address: downloading backups and exports, signing in to document sources (Notion, Google Drive and the like), and turning on notifications. The app can manage your notification preferences, but it doesn't show notifications yet.

## Signing out, or changing servers

**Settings → Profile → Sign out** signs this app out and forgets its sign-in. The next sign-in screen keeps the same server address, and **Change** switches to another server. Your sessions and workspaces stay on the server you left; nothing is moved or deleted.

If the app can't reach its server, it shows **Can't reach Pikibun** with **Try again** and **Sign out**. The app shows it for your [self-hosted](self-host.md) Pikibun too, whenever that isn't running: start it under **Settings → Self host**, or choose **Sign out** to reach the sign-in screen's **Run Pikibun on this Mac**.
