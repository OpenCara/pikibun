import { mount } from "nsh";
import { pageRoute } from "../../src/lib/page";
import { Root } from "../../src/Root";

// The app opened at an invite link, as the web's page would open it, signed in natively against the stub server.
pageRoute.set({ name: "join", token: "invite-token" });
mount(Root);
