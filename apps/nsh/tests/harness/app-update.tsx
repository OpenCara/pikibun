import { host as embedder, mount, signal, Text, View } from "nsh";
import { AppUpdateRows, SidebarUpdate } from "../../src/components/AppUpdate";
import { configureAppUpdate, type CleanUp, type UpdateRunner } from "../../src/lib/app-update";
import { Button, Section } from "../../src/ui";

const params = embedder.params as { current?: unknown; os?: unknown; arch?: unknown; outcome?: unknown; cleanUp?: unknown };
const outcome = String(params.outcome ?? "ok");
const sent = signal<string[]>([]);
const say = (line: string) => sent.update(list => [...list, line]);
const later = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let resume: (() => void) | undefined;
const gate = () => new Promise<void>(resolve => { resume = resolve; });

const runner: UpdateRunner = {
  async download(asset, progress) {
    say(`download ${asset.url} ${asset.sha256 ?? "no digest"}`);
    for (const share of [0, 0.25, 0.5]) {
      progress(Math.round(asset.size * share), asset.size);
      if (outcome === "paused" && share === 0.5) await gate();
      else await later(10);
    }
    if (outcome === "download-fails") throw new Error("The download doesn't match the checksum GitHub published for it. Try again.");
    progress(asset.size, asset.size);
    return `/Users/ada/Library/Application Support/com.pikibun.app/updates/${asset.name}`;
  },
  async install(file, update) {
    say(`install ${file} ${update.version}`);
    await later(20);
    if (outcome === "install-fails") throw new Error("/Applications can't be written by ada: install the update from its release page as an administrator.");
  },
  async restart() { say("restart"); },
  async cleanUp(current): Promise<CleanUp> {
    say(`clean up ${current}`);
    if (params.cleanUp === "slow") { await later(300); say("cleaned up"); }
    return params.cleanUp === "installed" ? { installed: current } : params.cleanUp === "failed" ? { failed: "0.17.0" } : {};
  },
};

const updater = configureAppUpdate({
  current: typeof params.current === "string" ? params.current : "0.16.0",
  os: typeof params.os === "string" ? params.os : "macos",
  arch: typeof params.arch === "string" ? params.arch : "aarch64",
  runner,
});
updater.start(1);

mount(() => (
  <View style={{ flex: 1, gap: 16, padding: 16 }}>
    <View style={{ width: 260 }}><SidebarUpdate onDetails={() => say("details")} /></View>
    <Button testID="fake-download-continue" label="Continue the download" onPress={() => resume?.()} />
    <Section title="This app"><AppUpdateRows /></Section>
    <View testID="fake-sent">
      <Each of={sent()} key="index">{line => <Text>{`sent ${line()}`}</Text>}</Each>
    </View>
  </View>
));
