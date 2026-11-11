# Running Pikibun on your own computer

For one person, Pikibun can run entirely on their own computer: the server, the web app and the computer itself as the host that runs the sessions. Nothing is deployed and no account at a Pikibun service is needed; it is the same server, so everything in [Using Pikibun](../README.md#documentation) works, for its one user.

```sh
npx pikibun@latest serve
```

- **Sign-in** is with GitHub, through a GitHub OAuth app of your own, registered once at <https://github.com/settings/applications/new> with the homepage `http://127.0.0.1` and the callback URL `http://127.0.0.1/api/auth/github/callback` (GitHub accepts it on any port of 127.0.0.1). The first `pikibun serve` asks for its client ID and, at a hidden prompt, its secret (or takes `--github-client-id` with the secret in `PIKIBUN_GITHUB_CLIENT_SECRET`).
- **One owner.** The first run prints a sign-in link. The GitHub account that signs in through it becomes the owner, and from then on the only account that can sign in: any other is refused before its GitHub token is stored. Keep the link private until you have used it.
- **This computer only.** It listens on `http://127.0.0.1:7878` (`--port` changes it), so nothing else on the network reaches it.
- **This computer is the host.** Once the owner has signed in, the computer pairs itself with the server, with no code to copy, and appears under **Settings → Hosts**. It runs sessions as `pikibun connect` would: in the bubblewrap sandbox on Linux with its prerequisites, otherwise only with `--unsafe-no-sandbox`. `--no-host` serves without it.
- **Its data** (the SQLite database, session backups, the secrets it was set up with, and this computer's pairing) is in `~/.local/share/pikibun/server` (`--state-dir` chooses another), private to your user. It is separate from `pikibun connect`'s, so a computer connected to a team's server stays connected. One Pikibun at a time runs from it: a second `pikibun serve` on the same state says the first is running.

To use it from the Mac, Windows or Linux app, see [Self host](desktop/self-host.md) in the desktop app user guide.

Run `npx pikibun serve --help` for every option. The server is the one [Running the server](self-hosting.md) describes, started with `LOCAL_MODE` (see [Configuration](self-hosting.md#configuration)).

## Sharing it with others

The same Pikibun, from the same data, can also serve a team: `pikibun serve --share`. It then runs as a full server rather than with `LOCAL_MODE`: people sign in, create workspaces and pair their own hosts, and it has administrators and a sign-up policy like any other.

- **A public HTTPS address.** Sign-in cookies need HTTPS, so Pikibun still serves plain HTTP on this computer (`127.0.0.1:7878`, or every interface with `--listen all`), and a TLS proxy or tunnel you run serves the public address and forwards to it: `tailscale serve` or Funnel, Cloudflare Tunnel, Caddy. Give that address with `--public-origin https://…`, and `--trust-proxy` if the proxy sets `X-Forwarded-Proto`/`-Host`.
- **Administrators** (`--admin`, repeatable): user IDs such as `github:12345` or `password:alice`. The first with an account owns this computer's host, which pairs itself once they have signed in (with a pairing of its own, so going back to running Pikibun for yourself reuses the other).
- **Sign-in and sign-up**: GitHub through an OAuth app whose callback is `<public address>/api/auth/github/callback` (not the `127.0.0.1` one), usernames and passwords (`--password-auth`), or both; `--signup` is `invite` (the default), `open` or `off`, as [Who can create an account](accounts.md#who-can-create-an-account) describes. `--create-admin USERNAME` makes a listed password administrator's account.

The settings are kept with the state, so later runs need only `--share`; without it, the same data serves you alone again.
