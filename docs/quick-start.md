# Quick start

Just for yourself, on one computer? `npx pikibun@latest serve` runs all of it there, with no server to deploy: see [Running Pikibun on your own computer](local.md). Using the Mac, Windows or Linux app? The [desktop app user guide](desktop/README.md) helps you choose between client, host and self host. For a team:

1. **Run the server** with Docker and create its first administrator with `--create-admin`: the image signs people in with a [username and password](accounts.md#username-and-password), and with GitHub once you add a GitHub OAuth app, and takes new accounts only through invite links. See [Running the server](self-hosting.md).
2. **Sign in** with **Continue with GitHub** or your username and password, then choose **New workspace** and name it.
3. **Add a source**: **Settings → Workspaces →** your workspace **→ Sources → Add repository**. Pick the account, the repository and optionally a branch, tag or commit, then **Bind repository**. A Notion page or a folder or document in Google Drive, Dropbox, OneDrive, Feishu/Lark or Tencent Docs works too (see [Document sources](repositories.md#document-sources)).
4. **Pair a host**: on a Linux or WSL2 machine with Node.js 24, Pi configured with at least one model, and `bubblewrap`, Python 3, Git and `flock` installed, open **Settings → Hosts → Pair a host**, name the host and **Create pairing code** (a host isn't paired into a workspace: it is yours, in each of your workspaces). Run the command it shows on the host and type the code at the hidden prompt:

   ```sh
   npx pikibun@latest connect --server https://pikibun.example.com --pairing-id PAIRING_ID
   ```

5. **Start a session**: select the workspace in the sidebar, choose your host in **Host**, describe the task and press Enter.
6. Watch the agent's commands and commits run in the transcript; choose **Read only** in the chat box for a message that should change nothing.

To try your host on your own first, skip steps 2 and 3: every account has a **Private** workspace, pinned at the top of the sidebar, where sessions need no source and nobody else can join (see [Your private workspace](workspaces.md#your-private-workspace)). Pair a host and start a session there.

To bring in teammates, share the workspace's invite link (**Settings → Workspaces → Members → Invite link**) and accept them under **Pending members** once they've signed in from it; where the server takes new accounts only through invitations (`SIGNUP=invite`, as the Docker image does; see [Who can create an account](accounts.md#who-can-create-an-account)), that is how they get one. Or they sign in once and send you their **User ID** from **Settings → Profile**, and you add them under **Settings → Workspaces → Members → Add member**. To let them run sessions on your machine, share your host with the workspace under **Settings → Hosts →** your host **→ Sharing**. Each workspace page shows a **Setup** checklist (**Add a source**, **Pair a host**, **Start a session**) until all three are done.
