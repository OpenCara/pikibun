# Running Pikibun on your own computer

For one person, Pikibun can run entirely on their own computer: the server, the web app and the computer itself as the host that runs the sessions. Nothing is deployed and no account at a Pikibun service is needed; it is the same server, so everything in [Using Pikibun](../README.md#documentation) works, for its one user.

```sh
npx pikibun@latest serve
```

- **Sign-in needs no account anywhere.** Every run prints a sign-in link, `http://127.0.0.1:7878/api/auth/local?token=…`: opening it signs you in as the owner. It signs in whoever opens it, so keep it private. Its token is made afresh at each start and kept only in memory, so a link from an earlier run, in your browser's history or a terminal log, signs nobody in once Pikibun has restarted; restart it to retire one you shared by mistake. Sessions you already signed in keep working across restarts. The Pikibun app signs in with it for you, and takes the link pasted on its sign-in screen for a `pikibun serve` it didn't start. Once signed in, **Settings → Profile → Signed-in apps → Sign in an app** makes a [code](accounts.md#signing-in-an-app-with-a-code) for another app on this computer, with nothing to type; an app signed in with a code can't make the next one.
- **One owner.** The first sign-in makes the owner's account, named after your user on this computer (`password:ada` for the user `ada`, or `password:owner`), with no password. Nobody else can sign in, and there is no GitHub sign-in. That account reaches every Git provider through the personal access tokens under **Settings → Profile → Connected accounts**, github.com included: **Connect** on the GitHub row takes a personal access token (classic `repo`, `workflow` and `read:user`, or fine-grained with Contents, Pull requests, Issues and Workflows read and write), which binds github.com repositories and runs the GitHub tools as that account. Pikibun can't reset such a token after a push as it resets a GitHub sign-in's, so it stays valid until it expires or you revoke it on GitHub. A Pikibun set up while `pikibun serve` signed in with GitHub keeps the GitHub account that owns it, and its repositories, and signs it in with the link.
- **This computer only.** It listens on `http://127.0.0.1:7878` (`--port` changes it), so nothing else on the network reaches it.
- **This computer is the host.** Once the owner has signed in, the computer pairs itself with the server, with no code to copy, and appears under **Settings → Hosts**. It runs sessions as `pikibun connect` would: in the bubblewrap sandbox on Linux with its prerequisites, otherwise only with `--unsafe-no-sandbox`. `--no-host` serves without it.
- **Its data** (the SQLite database, session backups, the secrets it was set up with, and this computer's pairing) is in `~/.local/share/pikibun/server` (`--state-dir` chooses another), private to your user. It is separate from `pikibun connect`'s, so a computer connected to a team's server stays connected. One Pikibun at a time runs from it: a second `pikibun serve` on the same state says the first is running.

To use it from the Mac, Windows or Linux app, see [Self host](desktop/self-host.md) in the desktop app user guide.

Run `npx pikibun serve --help` for every option. The server is the one [Running the server](self-hosting.md) describes, started with `LOCAL_MODE` (see [Configuration](self-hosting.md#configuration)).

## Sharing it with others

The same Pikibun, from the same data, can also serve a team: `pikibun serve --share`. It then runs as a full server rather than with `LOCAL_MODE`: people sign in, create workspaces and pair their own hosts, and it has administrators and a sign-up policy like any other.

- **A public HTTPS address.** Sign-in cookies need HTTPS, so Pikibun still serves plain HTTP on this computer (`127.0.0.1:7878`, or every interface with `--listen all`), and a TLS proxy or tunnel you run serves the public address and forwards to it: `tailscale serve` or Funnel, Cloudflare Tunnel, Caddy. Give that address with `--public-origin https://…`, and `--trust-proxy` if the proxy sets `X-Forwarded-Proto`/`-Host`.
- **Administrators** (`--admin`, repeatable): user IDs such as `github:12345` or `password:alice`. List yourself, the owner, among them (`password:ada`), and give yourself a password with `--create-admin ada` to sign in at the public address. The first with an account owns this computer's host, which pairs itself once they have signed in (with a pairing of its own, so going back to running Pikibun for yourself reuses the other).
- **Sign-in and sign-up**: usernames and passwords (`--password-auth`), GitHub through an OAuth app whose callback is `<public address>/api/auth/github/callback` (`--github-client-id`, with its secret asked at a hidden prompt or read from `PIKIBUN_GITHUB_CLIENT_SECRET`), or both; `--signup` is `invite` (the default), `open` or `off`, as [Who can create an account](accounts.md#who-can-create-an-account) describes. `--create-admin USERNAME` makes a listed password administrator's account, or gives the owner who signed in without one its first password.

The settings are kept with the state, so later runs need only `--share`; without it, the same data serves you alone again.
