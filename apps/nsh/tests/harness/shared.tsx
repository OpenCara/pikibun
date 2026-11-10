import { mount } from "nsh";
import { SharedSession } from "../../src/screens/SharedSession";
import { ORIGIN } from "../fixtures";

mount(() => <SharedSession token="share-token" origin={ORIGIN} />);
