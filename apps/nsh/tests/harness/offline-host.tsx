import { host as embedder, mount, signal, Text, View } from "nsh";
import { OfflineHostBanner } from "../../src/components/OfflineHost";
import { computerHosts, setHostLauncher, setUnsandboxedConsent } from "../../src/lib/this-computer";
import type { ConnectorInfo } from "../../src/shared";

const params = (embedder.params ?? {}) as { paired?: unknown; state?: unknown; inspectMs?: unknown; connectorId?: unknown };
const SERVER = "https://pikibun.test";
const paired = typeof params.paired === "string" ? params.paired : SERVER;
const inspectMs = typeof params.inspectMs === "number" ? params.inspectMs : 1;
const sent = signal<string[]>([]);
const settings = signal(0);

setUnsandboxedConsent(async () => true);
setHostLauncher(() => {
  const messages: ((value: unknown) => void)[] = [];
  const emit = (value: unknown, ms = 1) => setTimeout(() => { for (const listener of messages) listener(value); }, ms);
  setTimeout(() => emit({ type: "ready" }), 1);
  return {
    send: message => {
      const request = message as { type: string; id: number; server?: string };
      sent.update(list => [...list, request.type]);
      if (request.type === "inspect") {
        emit({ type: "result", id: request.id, ok: true, inspection: { platform: "darwin", stateDir: "/Users/ada/.local/share/pikibun/connector", mode: "sandboxed", sandbox: "seatbelt",
          prerequisites: [], models: [{ provider: "anthropic", modelId: "claude-sonnet", name: "Claude Sonnet" }], pairedServer: paired } }, inspectMs);
        if (typeof params.state === "string") emit({ type: "status", state: params.state, server: paired }, inspectMs + 1);
      } else if (request.type === "start") {
        emit({ type: "status", state: "starting", server: request.server });
        emit({ type: "result", id: request.id, ok: true });
        emit({ type: "status", state: "connected", server: request.server, connectorId: typeof params.connectorId === "string" ? params.connectorId : "c1" });
      } else emit({ type: "result", id: request.id, ok: true });
    },
    onMessage: listener => { messages.push(listener); },
    onOutput: () => undefined,
    onExit: () => undefined,
    end: () => undefined,
    kill: () => undefined,
  };
});

const offline: ConnectorInfo = { id: "c1", ownerId: "u1", ownerName: "ada", name: "ada-mac", createdAt: "2026-11-01T10:00:00.000Z", revokedAt: null, online: false,
  models: [], workspaceIds: ["w1"], capabilities: { platform: "darwin", sandbox: true, productionShell: false } } as unknown as ConnectorInfo;

mount(() => (
  <View style={{ flex: 1 }}>
    <OfflineHostBanner host={offline} server={SERVER} openSettings={() => settings.update(count => count + 1)} />
    <Text>{`hosts: ${computerHosts().all().map(item => `${item.pairedWith() ?? "unpaired"}=${item.state()}`).join(" ")}`}</Text>
    <Text>{`settings opened: ${settings()}`}</Text>
    <Text>{`sent: ${sent().join(",")}`}</Text>
  </View>
));
