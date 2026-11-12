# Signing in and your profile

Pikibun signs people in with GitHub, and asks GitHub for the `read:user user:email repo workflow` scopes. That token is kept encrypted on the server and used to read your repositories, open your pull requests and act on GitHub for your sessions; it reaches a host only when a push uses your own account. A browser sign-in lasts 7 days, an app's sign-in 30 days. Where the operator allows it, people can also sign in with a [username and password](#username-and-password). An app can also [sign in with a code](#signing-in-an-app-with-a-code) made where you are already signed in.

## Who can create an account

The first sign-in creates an account, as far as the operator's `SIGNUP` setting allows, for GitHub and password sign-ins alike:

- `open`: anyone who can reach the server. Unset, `SIGNUP` means this for GitHub, as before.
- `invite`: only someone who opens a workspace's [invite link](workspaces.md#invite-links-and-pending-members) and signs in, or signs up, from it. The new account asks to join that workspace in the same step, so an owner or admin still accepts them before they see anything. A link turned off or replaced admits nobody new, and while 200 people wait to join a workspace its link creates no more accounts. Unset, `SIGNUP` means this for passwords, and the [Docker image](self-hosting.md#docker) sets it, for GitHub too.
- `off`: nobody new, apart from the operator's own: the GitHub accounts `ADMIN_USER_IDS` lists, and password accounts made with `--create-admin` (see [Administration](self-hosting.md#administration)).

Existing accounts sign in whatever `SIGNUP` says; it decides only who may be added. In every mode, `ADMIN_USER_IDS`'s GitHub accounts can sign up, so a server's administrators can always set it up. Someone signing up through an invite link where `SIGNUP=open` asks to join its workspace too. The apps can't open invite links, so where `SIGNUP=invite` a new person creates their account through the link in a browser first, then signs in on the app. A refused sign-in keeps nothing: no account, and not the token GitHub issued.

## Your username

Every account has a unique username on the server: 3 to 39 letters, digits, `-` and `_`, starting with a letter or digit, not case-sensitive. Teammates see you by it in member lists and can type it to name you, and you can sign in with it and a password where the server takes passwords. Password accounts and GitHub accounts share one set of usernames, so a name belongs to one account whichever way it signs in. A username can't be changed later.

- **GitHub accounts** choose theirs right after their first sign-in (the web app asks before anything else, invite links included; accounts from before usernames are asked at their next visit). It starts as your GitHub login where that is a valid username, and you can type another. Where the server takes passwords you can also set an optional password in the same step, to sign in later with your username and password as well as GitHub. A local server (`pikibun serve`) has only its owner and doesn't ask.
- **Password accounts** chose theirs when signing up: it is the name in their user ID.
- A username listed as an administrator in `ADMIN_USER_IDS` (`password:<username>`) is reserved for that administrator.

## Username and password

Where the operator sets `PASSWORD_AUTH=true`, as the [Docker image](self-hosting.md#docker) does, the sign-in page also offers a username and password, and **New here? Create an account** where `SIGNUP` lets the visitor sign up: by default only on an invite link's sign-in page. Then:

- The username makes your user ID, `password:<username>`, so teammates can add you to a workspace by it before you ever sign in. It can't be changed later.
- Passwords are at least 12 characters, other than the username. The server keeps only a salted scrypt hash. After five wrong passwords in a row the account refuses sign-ins for 30 seconds, doubling with each further miss up to 15 minutes; a correct sign-in resets the count.
- **Settings → Password** changes it with your current one, which signs out every other browser and app signed in as you. There is no reset by email: someone who forgets theirs asks the server's operator for a new one (`--reset-password`, see [Administration](self-hosting.md#administration)).

A **GitHub account** can sign in with its username and a password too, once it sets one: in the username step after signing up, or later under **Settings → Password**. It stays a GitHub account, with its GitHub token and repositories, whichever way it signs in. Your GitHub sign-in vouches for you where a password can't:

- Setting your first password, or a new one without the current one (if you forgot it), or removing it without the current one, needs a GitHub sign-in from the last 15 minutes. The page offers **Sign in with GitHub again** and brings you back. So a browser left signed in, or a stolen sign-in, can't add a password to keep its way in. Failed sign-ins lock only the password: someone who knows your username can't use them to stop you from replacing or removing it this way.
- Changing it with the current password signs out every other browser and app signed in as you. **Remove password** takes you back to GitHub only, and signs out the browsers and apps that signed in with the password.
- Turning `PASSWORD_AUTH` off ends the sign-ins made with a password at once; your GitHub sign-ins go on, and **Settings → Password** still lets you remove the password you set. The operator's `--reset-password` works for your username as well.
- A password account holds no GitHub token, so it can't bind or clone **github.com** repositories (not even ones a teammate bound: a session reads repositories with its owner's own access), push with its own GitHub account, or use the GitHub tools. It works with every other Git provider, GitHub Enterprise Server included, through personal access tokens under **Git accounts**. Its Git author email starts as `<username>@users.pikibun.invalid`; set your own under **Identity**.
- The apps sign in with your username and password too, and are then listed under **Signed-in apps** as a GitHub sign-in is. Create a new password account on the web first: the apps only sign in to one.
- Turning `PASSWORD_AUTH` off signs every password account out at once and refuses their sign-ins; turning it on again lets them back in.

**Settings → Profile** holds:

- **Identity**: **Display name**, **Git author name** and **Git author email**. Commits in sessions you own use this identity; new sessions pick up saved changes.
- **Environment**: up to 32 non-secret `APP_` variables (for example `APP_PROJECT=web`) sent to the host of every session you own. Values are at most 2,048 characters, and names containing `TOKEN`, `SECRET`, `PASSWORD`, `PRIVATE_KEY` or `API_KEY` are refused: credentials belong in Git accounts or in Pi on the host.
- **Git accounts**: your GitHub sign-in plus personal access tokens for other Git providers (see [Repositories and Git accounts](repositories.md)).
- **Signed-in apps**: the apps signed in as you, each of which you can sign out, and **Sign in an app**, which [signs in another with a code](#signing-in-an-app-with-a-code).
- **Account**: your **Username**, your **User ID** (owners add you to workspaces with it) and **Sign out**.

## Signing in an app with a code

The Pikibun app on a phone, tablet or computer can sign in without GitHub or a password there, with a code made where you are already signed in: Pikibun on the web, or another of your apps.

1. There, open **Settings → Profile → Signed-in apps → Sign in an app**. It shows a QR code of the sign-in link (`pikibun://auth/code?server=…&code=…`), **Open in Pikibun** (on the web) and **Copy link**.
2. On a phone or tablet, scan the QR code with the camera and open the link in Pikibun. On a computer, choose **Open in Pikibun** where the app is installed, or copy the link and paste it under **Sign in with a code** on the app's sign-in screen.
3. The app shows the server the link is for and asks first; choose **Sign in**. The page that made the code says which app used it, and the app is listed under **Signed-in apps** as signed in "with a code", for 30 days like any other app.

What keeps a code safe:

- It works once and for 10 minutes. The server keeps only its hash, and you can have at most 5 waiting; **Cancel** ends one sooner.
- Making one takes your password, or a GitHub sign-in from the last 15 minutes (**Sign in with GitHub again** brings you back), so a browser left signed in, or a stolen sign-in, can't turn itself into a 30-day app.
- It ends with the browser or app that made it: signing that out, changing your password or a suspension makes it worthless. An app signed in with a password-made code ends, as the password's sign-ins do, when the operator turns `PASSWORD_AUTH` off.
- Anyone who has the link or the QR code can sign in as you until it is used or expires, so show it to nobody. The app always asks before a link signs it in, so a link someone sends you can't sign your app in to their account or their server unnoticed.

**Settings → Password**, where the server takes passwords (or your account still has one), shows how you sign in (your username, GitHub, and whether you have a password) and sets, changes or removes your password, as above.

**Settings → Appearance** switches between the Light, Dark and System themes.
