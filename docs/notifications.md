# Notifications

Pikibun tells you when one of your sessions needs you or is done, in your browser or the Pikibun app:

- **Finished**: the agent finished the message it was working on.
- **Failed**: the agent stopped on an error.

You hear about sessions you own, and about sessions you sent the latest message to (as long as you can still read
them). A message from a schedule counts as its session owner's. Turning notifications on is up to each person, on each
device.

## Turning them on

- **Web**: **Settings → Notifications → Notifications on this device**. The browser asks for permission first. In
  browsers with Web Push (Chrome, Edge, Firefox, and Safari on macOS), notifications arrive even when no Pikibun tab is
  open. In other browsers, and on servers that can't send Web Push (see below), they arrive while a Pikibun tab is
  open. On iPhone and iPad, Safari only allows Web Push for a site added to the Home Screen.
- **Desktop and mobile apps**: **Settings → Notifications → Notifications on this device**. The system asks for
  permission first (on Windows and Linux there is no prompt). The app shows them while it's open, in front or behind
  other windows, by asking Pikibun every 20 seconds. Phones pause an app in the background, so on Android they arrive
  once you're back in it.
- **iPhone and iPad app**: the same switch. The app also gets notifications while it's in the background or closed,
  pushed through Apple's push service, [when no other device took them](#the-iphone-comes-last).

Clicking or tapping a notification opens its session. A notification about the session you're looking at isn't shown
again as a banner.

## The iPhone comes last

A notification reaches the iPhone and iPad app only if no other device of yours took it. A browser or a desktop app
that shows a notification (or leaves it out because you're looking at its session) tells Pikibun so, and the phone is
then left alone:

- Pikibun tells your browsers at once, and the open apps and pages when they next ask, within 20 seconds.
- It waits 30 seconds for one of them to take the notification. If one does, nothing goes to the phone.
- If none does (the computer is asleep, the browser is closed, no app is open), the push goes to the phone.
- A session that waited for you and got its answer on another device within those 30 seconds isn't pushed either.
- Where nothing else could take it (no browser turned on, and no app or page of yours open in the last minute), the
  push goes out at once.

So a computer that stays on with Pikibun open, or with a browser you turned notifications on in, keeps them off your
phone even when you're away from it. Turn notifications off on that computer to get them on the phone. The iPhone app
follows the same rule while it's open: it shows a notification only if it took it before any other device.

**Send a test** is the exception: it goes to every device at once.

Under **Notify me when**, choose which of the two you get, on every device. Turn off **Show session titles** to keep
session titles off your lock screen. Notifications then only say what happened (*A session finished.*).

**Devices** lists the browsers and the iPhone and iPad apps that get your notifications even when Pikibun isn't
open. **Remove** stops one. **Send a test** sends a notification to all of them. Each one belongs to the sign-in that turned it on: signing
out of it, its sign-in expiring, or signing an app out under **Settings → Profile → Signed-in apps** also stops its
notifications. The device then keeps notifications off until they are turned on again, so if someone else signs in
on that device, they don't get yours.

## What passes through push services

Web Push goes through the browser maker's push service (Google, Mozilla, Apple or Microsoft). It is encrypted from
Pikibun's server to your browser ([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)), so the push service only sees
that a message passed.

Pushes to the iPhone and iPad app go through [Expo's push service](https://docs.expo.dev/push-notifications/overview/)
and then Apple's (APNs). Both can read them: the notification's title and text, and the session's ID. Turn off **Show
session titles** to keep titles and workspace names out of them. Expo holds the app's key for Apple's service, which
is why any Pikibun server, a self-hosted one too, can push to the app without a key of its own. When you turn
notifications on, the app sends Expo its device token from Apple and gets the Expo push token Pikibun's server then
addresses it by.

## For operators

Web Push needs no setup. The server makes its Web Push (VAPID) key pair on first use and keeps it in the database, its
private half encrypted with `VAULT_KEY`. Without a usable `VAULT_KEY`, the server sends no Web Push and browsers fall
back to notifications while a tab is open. The server sends Web Push only to the browsers' push services above, never
to another address a client gives it. It also needs outbound HTTPS to them.

Pushes to the iPhone and iPad app need no setup either. The server sends them to Expo's push service
(`https://exp.host/--/api/v2/push/send`), which relays them to Apple with the key of the app's Expo project, so it
needs outbound HTTPS to `exp.host`. A device is addressed only by an Expo push token, never by an address a client
gives. Expo's answer removes a device it no longer knows. The pushes that wait for another device (see
[above](#the-iphone-comes-last)) are kept in the database, so a restart sends them late rather than not at all. A
push counts as sent only once Expo took it: while Expo can't be reached or refuses it for now, the server tries again
every minute for an hour, and the app, once open, can still show the notification itself.

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEB_PUSH_CONTACT` | the server's `APP_ORIGIN` where it is `https://` | A `mailto:` or `https://` contact that push services may use to reach the operator |
| `EXPO_ACCESS_TOKEN` | none | An access token for Expo's push service, sent with each request. Only needed if the app's Expo project turns on enhanced push security |

Each person's notification feed (which open pages and desktop windows poll) keeps a day of notifications.
