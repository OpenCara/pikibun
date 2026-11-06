import { computed, effect, signal, untracked, View, windowSize } from "nsh";
import { createNavStack, NavPage, NavStack } from "nsh/base";
import { AppDataContext, createAppData } from "./lib/app-data";
import { auth, restore } from "./lib/auth";
import { NewSessionForm } from "./screens/NewSession";
import { OpenSession } from "./screens/OpenSession";
import { headerProps } from "./screens/PageHeader";
import { SessionList } from "./screens/SessionList";
import { SessionView } from "./screens/SessionView";
import { Settings } from "./screens/Settings";
import { SignIn } from "./screens/SignIn";
import { palette } from "./theme";
import { EmptyState, IconButton, Loading } from "./ui";

type Route =
  | { name: "sessions" }
  | { name: "session"; id: string }
  | { name: "new" }
  | { name: "open" }
  | { name: "settings" };

/** Phones stack the list and the session; wider windows (tablets, desktops, the web) show them side by side. */
const WIDE = 700;

export function Root() {
  void restore();
  const signedIn = () => auth().status === "signedIn";
  return (
    <View style={{ flex: 1, backgroundColor: palette().background }}>
      <If when={auth().status !== "loading"} else={<Loading />}>
        <If when={signedIn()} else={<SignIn />}>
          <Shell />
        </If>
      </If>
    </View>
  );
}

/** Everything behind sign-in. Created per sign-in, so lists never carry over to another account. */
function Shell() {
  const data = createAppData();
  const nav = createNavStack<Route>([{ name: "sessions" }]);
  // A size of zero is no layout to follow (a minimized window; NSH 0.4's headless engine also reports 0×0 after an
  // appearance change): the last real width stands.
  let lastWidth = 0;
  const width = computed(() => {
    const current = windowSize().width;
    if (current > 0) lastWidth = current;
    return lastWidth;
  });
  const wide = () => width() >= WIDE;
  /** The session beside the list in the wide layout. */
  const selected = signal<string | null>(null);

  function openSession(id: string) {
    if (wide()) {
      selected.set(id);
      nav.popToRoot();
    } else {
      nav.push({ name: "session", id });
    }
  }
  /** From a page above the list (new session, open by ID): the session takes that page's place. */
  function openFromPage(id: string) {
    if (wide()) {
      nav.popToRoot();
      selected.set(id);
    } else {
      nav.replace({ name: "session", id });
    }
  }
  // A window narrowed while a session is open beside the list keeps it open, as its own page; widened, the page goes
  // back beside the list.
  effect(() => {
    const isWide = wide();
    untracked(() => {
      const top = nav.routes()[nav.routes().length - 1];
      if (!isWide && selected()) {
        const id = selected()!;
        selected.set(null);
        nav.push({ name: "session", id });
      } else if (isWide && top?.name === "session") {
        nav.popToRoot();
        selected.set(top.id);
      }
    });
  });

  const back = () => nav.pop();
  const listActions = () => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <IconButton testID="open-by-id" icon="⇥" label="Open a session by ID" onPress={() => nav.push({ name: "open" })} />
      <IconButton testID="new-session" icon="＋" label="New session" onPress={() => nav.push({ name: "new" })} />
    </View>
  );
  const settingsButton = () => <IconButton testID="open-settings" icon="⚙" label="Settings" onPress={() => nav.push({ name: "settings" })} />;

  return (
    <AppDataContext.Provider value={data}>
      <NavStack state={nav} style={{ flex: 1 }} testID="nav">
        {route => {
          switch (route.name) {
            case "sessions":
              return (
                <NavPage title="Sessions" {...headerProps({ title: "Pikibun", leading: settingsButton(), actions: listActions() })}>
                  <If when={wide()} else={<SessionList onOpen={openSession} onNew={() => nav.push({ name: "new" })} />}>
                    <View style={{ flex: 1, flexDirection: "row" }}>
                      <View style={{ width: 340, borderRightWidth: 1, borderColor: palette().border }}>
                        <SessionList selectedId={selected()} onOpen={openSession} onNew={() => nav.push({ name: "new" })} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <If when={selected()} else={<EmptyState title="No session open">Choose a session from the list, or start a new one.</EmptyState>}>
                          {/* Keyed by id: another session is another view, with its own stream, drafts and picks. */}
                          <Each of={selected() ? [selected()!] : []}>
                            {id => <SessionView id={id()} page={false} openSession={openSession} />}
                          </Each>
                        </If>
                      </View>
                    </View>
                  </If>
                </NavPage>
              );
            case "session":
              return <SessionView id={route.id} page openSession={openSession} onBack={back} />;
            case "new":
              return (
                <NavPage title="New session" {...headerProps({ title: "New session", onBack: back })}>
                  <NewSessionForm onStarted={openFromPage} />
                </NavPage>
              );
            case "open":
              return (
                <NavPage title="Open a session" {...headerProps({ title: "Open a session", onBack: back })}>
                  <OpenSession onOpen={openFromPage} />
                </NavPage>
              );
            case "settings":
              return (
                <NavPage title="Settings" {...headerProps({ title: "Settings", onBack: back })}>
                  <Settings />
                </NavPage>
              );
          }
        }}
      </NavStack>
    </AppDataContext.Provider>
  );
}
