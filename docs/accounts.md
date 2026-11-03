# Signing in and your profile

Pikibun signs people in with GitHub, and asks GitHub for the `read:user user:email repo workflow` scopes. That token is kept encrypted on the server and used to read your repositories, open your pull requests and act on GitHub for your sessions; it reaches a host only when a push uses your own account. A browser sign-in (the Mac app's too) lasts 7 days, an iPhone or iPad app sign-in 30 days. Where the operator allows it, people can also sign in with a [username and password](#username-and-password).

## Who can create an account

The first sign-in creates an account, as far as the operator's `SIGNUP` setting allows, for GitHub and password sign-ins alike:

- `open`: anyone who can reach the server. Unset, `SIGNUP` means this for GitHub, as before.
- `invite`: only someone who opens a workspace's [invite link](workspaces.md#invite-links-and-pending-members) and signs in, or signs up, from it. The new account asks to join that workspace in the same step, so an owner or admin still accepts them before they see anything. A link turned off or replaced admits nobody new, and while 200 people wait to join a workspace its link creates no more accounts. Unset, `SIGNUP` means this for passwords, and the [Docker image](self-hosting.md#docker) sets it, for GitHub too.
- `off`: nobody new, apart from the operator's own: the GitHub accounts `ADMIN_USER_IDS` lists, and password accounts made with `--create-admin` (see [Administration](self-hosting.md#administration)).

Existing accounts sign in whatever `SIGNUP` says; it decides only who may be added. In every mode, `ADMIN_USER_IDS`'s GitHub accounts can sign up, so a server's administrators can always set it up. Someone signing up through an invite link where `SIGNUP=open` asks to join its workspace too. The iPhone, iPad and Mac apps can't open invite links, so where `SIGNUP=invite` a new person creates their account through the link in a browser first, then signs in on the app. A refused sign-in keeps nothing: no account, and not the token GitHub issued.

## Username and password

Where the operator sets `PASSWORD_AUTH=true`, as the [Docker image](self-hosting.md#docker) does, the sign-in page also offers a username and password, and **New here? Create an account** where `SIGNUP` lets the visitor sign up: by default only on an invite link's sign-in page. Then:

- The username (3 to 39 letters, digits, `-` and `_`, not case-sensitive) makes your user ID, `password:<username>`, so teammates can add you to a workspace by it before you ever sign in. It can't be changed later.
- Passwords are at least 12 characters, other than the username. The server keeps only a salted scrypt hash. After five wrong passwords in a row the account refuses sign-ins for 30 seconds, doubling with each further miss up to 15 minutes; a correct sign-in resets the count.
- **Settings → Profile → Password** changes it, which signs out every other browser signed in as you. There is no reset by email: someone who forgets theirs asks the server's operator for a new one (`--reset-password`, see [Administration](self-hosting.md#administration)).
- A password account holds no GitHub token, so it can't bind or clone **github.com** repositories (not even ones a teammate bound: a session reads repositories with its owner's own access), push with its own GitHub account, or use the GitHub tools. It works with every other Git provider, GitHub Enterprise Server included, through personal access tokens under **Git accounts**. Its Git author email starts as `<username>@users.pikibun.invalid`; set your own under **Identity**.
- The iPhone and iPad app still signs in with GitHub only; the Mac app shows the server's sign-in page, password included.
- Turning `PASSWORD_AUTH` off signs every password account out at once and refuses their sign-ins; turning it on again lets them back in.

**Settings → Profile** holds:

- **Identity**: **Display name**, **Git author name** and **Git author email**. Commits in sessions you own use this identity; new sessions pick up saved changes.
- **Environment**: up to 32 non-secret `APP_` variables (for example `APP_PROJECT=web`) sent to the host of every session you own. Values are at most 2,048 characters, and names containing `TOKEN`, `SECRET`, `PASSWORD`, `PRIVATE_KEY` or `API_KEY` are refused: credentials belong in Git accounts or in Pi on the host.
- **Git accounts**: your GitHub sign-in plus personal access tokens for other Git providers (see [Repositories and Git accounts](repositories.md)).
- **Signed-in apps**: the iPhone and iPad apps signed in as you, each of which you can sign out. The Mac app signs in as a browser does, so it isn't listed here; **Sign out** in it ends its sign-in.
- **Account**: your **User ID** (owners add you to workspaces with it) and **Sign out**.

**Settings → Appearance** switches between the Light, Dark and System themes.
