import { mount } from "nsh";
import { pageRoute } from "../../src/lib/page";
import { Root } from "../../src/Root";

pageRoute.set({ name: "join", token: "invite-token" });
mount(Root);
