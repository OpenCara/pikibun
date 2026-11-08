import { mount, signal } from "nsh";
import type { BrowserSource } from "../../../../packages/shared/src/browser";
import { browserSources, ToolSetup } from "../../src/settings/host-extensions";

// A host's browser setup while its status refreshes: the saved choice comes back every 50 ms as a new object with the
// same values, as the host's 10-second poll brings it, and the draft being typed must stay.
const saved = signal<{ source: BrowserSource; path?: string }>({ source: "auto" });
setInterval(() => saved.set({ source: "auto" }), 50);
mount(() => (
  <ToolSetup<BrowserSource> kind="browser" saved={saved()} owner busy={false} revoked={false} sources={browserSources} save={value => saved.set(value)} />
));
