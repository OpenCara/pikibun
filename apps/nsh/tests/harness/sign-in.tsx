import { host, mount } from "nsh";
import { SignIn } from "../../src/screens/SignIn";

const invite = (host.params as { invite?: unknown }).invite;
mount(() => <SignIn inviteToken={typeof invite === "string" ? invite : undefined} />);
