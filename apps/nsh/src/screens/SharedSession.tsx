import { computed, effect, List, safeArea, signal, Text, View } from "nsh";
import type { SharedSession as SharedRecord, SharedSessionView } from "../../../../packages/shared/src/sharing";
import { ApiError, createApi, errorMessage, pairToolResults } from "../shared";
import { timestamp } from "../lib/format";
import { inBackground } from "../lib/resource";
import { TranscriptEntry } from "../components/TranscriptEntry";
import { layout, palette, text, weight } from "../theme";
import { Badge, Banner, EmptyState, Loading, Logo } from "../ui";
import { PageHeader } from "./PageHeader";

/**
 * A share link reads the committed view with plain requests, never a stream: again soon while work runs, slowly while
 * the session is idle, backing off while it can't be reached (the web app's SharedSessionScreen).
 */
export const sharedTiming = { busyMs: 3_000, idleMs: 15_000, firstBackoffMs: 5_000, maxBackoffMs: 60_000 } as const;

/**
 * A session's read-only share link (`#/shared/<token>`): its conversation for anyone holding the link, signed in or
 * not, through the share-link API with the token, which never leaves the fragment otherwise.
 */
export function SharedSession(props: { token: string; /** The server: the page's own on the web (""). */ origin?: string }) {
  const record = signal<SharedRecord | null>(null);
  const view = signal<SharedSessionView | null>(null);
  const error = signal("");
  const invalid = signal(false);
  const expanded = signal<ReadonlySet<string>>(new Set());
  effect(() => {
    const token = props.token;
    const api = createApi({ baseUrl: props.origin ?? "", auth: "cookie" });
    const controller = new AbortController();
    const headers = { "X-Share-Token": token };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loading = false;
    let failures = 0;
    let busy = false;
    function schedule() {
      clearTimeout(timer);
      if (controller.signal.aborted) return;
      const delay = failures ? Math.min(sharedTiming.maxBackoffMs, sharedTiming.firstBackoffMs * 2 ** (failures - 1)) : busy ? sharedTiming.busyMs : sharedTiming.idleMs;
      timer = setTimeout(() => void load(), delay);
    }
    async function load() {
      if (controller.signal.aborted || loading) return;
      if (inBackground()) { schedule(); return; }
      loading = true;
      clearTimeout(timer);
      try {
        // The cheap check first: it shows the title even while the session's host can't be reached.
        const { session } = await api<{ session: SharedRecord }>("/api/shared", { signal: controller.signal, headers });
        if (controller.signal.aborted) return;
        record.set(session);
        const result = await api<{ view: SharedSessionView }>("/api/shared/view", { signal: controller.signal, headers });
        if (controller.signal.aborted) return;
        busy = result.view.busy;
        failures = 0;
        view.set(result.view);
        error.set("");
      } catch (reason) {
        if (controller.signal.aborted) return;
        // Only the link check answers not_found; an unreachable host answers with its own errors.
        if (reason instanceof ApiError && reason.status === 404 && reason.code === "not_found") {
          record.set(null); view.set(null); error.set(""); invalid.set(true);
          return;
        }
        failures++;
        error.set(errorMessage(reason));
      } finally {
        loading = false;
      }
      schedule();
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  });
  // Each tool call shows with the result that answered it, which isn't an entry of its own then.
  const transcript = computed(() => pairToolResults((view()?.entries ?? []).filter(entry => entry.role !== "system" || entry.text.trim())));
  const entries = () => transcript().entries;
  const toggle = (id: string) => expanded.update(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const badge = () => (error() ? <Badge tone="warning" dot>Reconnecting</Badge>
    : !view() ? <Badge dot>Connecting</Badge>
    : view()!.busy ? <Badge tone="running" dot>Working</Badge>
    : record()?.status === "archived" ? <Badge>Archived</Badge>
    : <Badge tone="success" dot>Live</Badge>);
  return (
    <View testID="shared-session" style={{ flex: 1, paddingTop: safeArea().top, backgroundColor: palette().background }}>
      <If when={record() && !invalid()}
        else={
          <If when={invalid() || error()} else={<Loading />}>
            {/* .welcome: the app's mark, what happened, and what to do. */}
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 40 }}>
              <View style={{ width: "100%", maxWidth: 420, alignItems: "center", gap: 20 }}>
                <Logo size={40} />
                <Text role="header" style={{ fontSize: text.heading, fontWeight: weight.light, textAlign: "center", color: palette().text }}>
                  {invalid() ? "This link doesn't work" : "Can't open this session right now"}
                </Text>
                <If when={invalid()} else={<Banner tone="danger" title="Couldn't load the shared session">{`${error()} This page keeps trying.`}</Banner>}>
                  <Text style={{ textAlign: "center", fontSize: text.body, color: palette().muted }}>The session's owner may have turned the link off. Ask them for a new one.</Text>
                </If>
              </View>
            </View>
          </If>
        }>
        <PageHeader leading={<Logo size={22} />} title={record()?.title ?? ""} subtitle={`Shared by ${record()?.ownerName ?? ""}`} testID="shared-header"
          actions={<View style={{ flexDirection: "row", gap: 4 }}>{badge()}<Badge>Read-only</Badge></View>} />
        <If when={error() && view()}>
          <View style={{ paddingTop: 12, paddingHorizontal: 16 }}>
            <Banner tone="warning" title="Can't refresh right now">{`${error()} This page keeps trying and shows the last view it received.`}</Banner>
          </View>
        </If>
        <If when={view()}
          else={<View style={{ flex: 1 }}><If when={error()} else={<Loading />}><EmptyState title="The conversation isn't available right now">The session's host may be offline. This page keeps trying.</EmptyState></If></View>}>
          {/* Follows new entries as the work goes on, unless the reader has scrolled up, as the session's own view does. */}
          <List each={entries()} keyExtractor={entry => entry.id} testID="shared-transcript" style={{ flex: 1 }} accessibilityLabel="Shared session history"
            contentStyle={{ paddingHorizontal: 16, paddingVertical: 24 }} maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 80 }}
            empty={() => <EmptyState title="The conversation begins here">Messages and tool results appear here as the work goes on</EmptyState>}>
            {entry => (
              <View style={{ width: "100%", maxWidth: layout.chat, alignSelf: "center" }}>
                <TranscriptEntry entry={entry()} userId="" shared expanded={id => expanded().has(id)} toggle={toggle} results={transcript().results.get(entry().id)} />
              </View>
            )}
          </List>
        </If>
        <View style={{ borderTopWidth: 1, borderColor: palette().border, paddingVertical: 10, paddingHorizontal: 16, paddingBottom: Math.max(10, safeArea().bottom) }}>
          <Text style={{ width: "100%", maxWidth: layout.chat, alignSelf: "center", fontSize: text.caption, color: palette().muted }}>
            {`${view()?.busy ? "Working… · " : view() ? "Idle · " : ""}Read-only, shared by link · Started ${record() ? timestamp(record()!.createdAt) : ""}`}
          </Text>
        </View>
      </If>
    </View>
  );
}
