# Notifications

Pikibun tells you when one of your sessions needs you or is done, on the web, in the Mac and Windows app, and on your
iPhone or iPad:

- **Needs approval**: a session's agent waits for someone to approve what it wants to do (see
  [Approvals](approvals.md)).
- **Finished**: the agent finished the message it was working on.
- **Failed**: the agent stopped on an error.

You hear about sessions you own, and about sessions you sent the latest message to (as long as you can still read
them). A message from a schedule counts as its session owner's. Turning notifications on is up to each person, on each
device.

## Turning them on

- **Web**: **Settings → Notifications → Notifications on this device**. The browser asks for permission first. In
  browsers with Web Push (Chrome, Edge, Firefox, and Safari on macOS), notifications arrive even when no Pikibun tab is
  open. In other browsers, and on servers that can't send Web Push (see below), they arrive while a Pikibun tab is
  open. On iPhone and iPad, Safari only allows Web Push for a site added to the Home Screen, so use the app there.
- **Mac and Windows app**: the same switch, in the app's **Settings → Notifications**. The app shows its own
  notifications while a Pikibun window is open, even one that is minimized or behind other windows. Once every
  window is closed (the app still running in the menu bar), they stop until you open one again. On macOS, allow
  Pikibun in **System Settings → Notifications** if macOS asks.
- **iPhone and iPad app**: **Settings → Notifications → On this device**. iOS asks for permission first.

Clicking or tapping a notification opens its session. A notification about the session you're looking at isn't shown
again as a banner.

Under **Notify me when**, choose which of the three you get, on every device. Turn off **Show session titles** to keep
session titles off your lock screen. Notifications then only say what happened (*A session is waiting for an
approval.*).

**Devices** lists the browsers and apps that get your notifications even when Pikibun isn't open. **Remove** stops
one. **Send a test** sends a notification to all of them. Each one belongs to the sign-in that turned it on: signing
out of it, its sign-in expiring, or signing an app out under **Settings → Profile → Signed-in apps** also stops its
notifications. If someone else then signs in on that device, they don't get yours.

## What passes through push services

Web Push goes through the browser maker's push service (Google, Mozilla, Apple or Microsoft). It is encrypted from
Pikibun's server to your browser ([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)), so the push service only sees
that a message passed. Notifications to the iPhone and iPad app go through Expo's push service and Apple's (APNs),
which see the notification's title and text. Turn off **Show session titles** if session titles shouldn't pass through
them.

## For operators

Web Push needs no setup. The server makes its Web Push (VAPID) key pair on first use and keeps it in the database, its
private half encrypted with `VAULT_KEY`. Without a usable `VAULT_KEY`, the server sends no Web Push and browsers fall
back to notifications while a tab is open. The server sends Web Push only to the browsers' push services above, never
to another address a client gives it. It also needs outbound HTTPS to them and to `exp.host` (Expo).

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEB_PUSH_CONTACT` | the server's `APP_ORIGIN` where it is `https://` | A `mailto:` or `https://` contact that push services may use to reach the operator |
| `EXPO_ACCESS_TOKEN` | none | An Expo access token, needed only if the app's Expo project requires one to send push notifications |

Each person's notification feed (which open pages and desktop windows poll) keeps a day of notifications.

### Building the iPhone and iPad app with notifications

The app gets an Expo push token, so its build needs an Expo project and Apple's push entitlement:

1. Create a project on [expo.dev](https://expo.dev) (`npx eas init` in `apps/mobile` writes its ID) and set
   `expo.extra.eas.projectId` in `apps/mobile/app.json`. Without it, the app says that this build can't get
   notifications.
2. Upload an APNs key for the bundle ID `com.pikibun.app` to that Expo project (**Credentials** on expo.dev, or
   `npx eas credentials`).
3. Enable **Push Notifications** for the App ID in the Apple Developer portal, and regenerate the App Store
   provisioning profile (the `IOS_PROVISIONING_PROFILE` secret of the release workflow, see
   [Development](development.md)). The `expo-notifications` config plugin adds the `aps-environment` entitlement at
   prebuild, and a profile without push capability can't sign it.

Every Pikibun server can send to an app built this way: the Expo push token is all a server needs.
