import { mount, signal } from "nsh";
import type { BrowserSource } from "../../../../packages/shared/src/browser";
import { browserSources, ToolSetup } from "../../src/settings/host-extensions";

const saved = signal<{ source: BrowserSource; path?: string }>({ source: "auto" });
setInterval(() => saved.set({ source: "auto" }), 50);
mount(() => (
  <ToolSetup<BrowserSource> kind="browser" saved={saved()} owner busy={false} revoked={false} sources={browserSources} save={value => saved.set(value)} />
));
