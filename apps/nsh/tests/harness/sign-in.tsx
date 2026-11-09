import { host, mount } from "nsh";
import { SignIn } from "../../src/screens/SignIn";

// The sign-in screen on its own, as a browser's page shows it: the headless engine has no page origin for the web's
// relative requests, so what needs them (signing in, the server's methods) is tested in Chrome by pnpm test:client-web.
const invite = (host.params as { invite?: unknown }).invite;
mount(() => <SignIn inviteToken={typeof invite === "string" ? invite : undefined} />);
