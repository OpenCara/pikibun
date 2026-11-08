import { mount } from "nsh";
import { SharedSession } from "../../src/screens/SharedSession";
import { ORIGIN } from "../fixtures";

// The share-link screen on its own, against the stub server: the headless engine has no page origin for the web's
// relative requests (the web build itself is tested in Chrome by pnpm test:client-web).
mount(() => <SharedSession token="share-token" origin={ORIGIN} />);
