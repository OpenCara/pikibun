import { computed, effect, safeArea, signal, Text, untracked, View, windowSize } from "nsh";
import { Button as BaseButton, createNavStack, NavPage, NavStack } from "nsh/base";
import { AppDataContext, createAppData } from "./lib/app-data";
import { auth, restore, session } from "./lib/auth";
import { pageRoute, showRoute, startPage, type PageRoute } from "./lib/page";
import { Icon, type IconName } from "./icons";
import { JoinWorkspace } from "./screens/JoinWorkspace";
import { NewSessionForm } from "./screens/NewSession";
import { OpenSession } from "./screens/OpenSession";
import { drawsHeaders, headerProps } from "./screens/PageHeader";
import { SessionList } from "./screens/SessionList";
import { SessionView } from "./screens/SessionView";
import { SharedSession } from "./screens/SharedSession";
import { SignIn } from "./screens/SignIn";
import { applyStoredAppearance } from "./settings/Appearance";
import { findSection, SectionList } from "./settings";
import { palette, radius, text } from "./theme";
import { Avatar, IconButton, Loading, Logo } from "./ui";

type Route =
  | { name: "sessions" }
  | { name: "session"; id: string }
  | { name: "new"; workspaceId?: string }
  | { name: "open" }
  /** The sections, with the chosen one beside them in the wide layout. */
  | { name: "settings"; section?: string; id?: string }
  /** One section as a page of its own (phones). */
  | { name: "settings-section"; section: string; id?: string }
  | { name: "join"; token: string };

/** Phones stack the list and the session; wider windows (tablets, desktops, the web) show a sidebar beside them. */
const WIDE = 700;

export function Root() {
  startPage();
  void applyStoredAppearance();
  void restore();
  const signedIn = () => auth().status === "signedIn";
  const shared = () => {
    const route = pageRoute();
    return route.name === "shared" ? route.token : null;
  };
  return (
    <View style={{ flex: 1, backgroundColor: palette().background }}>
      {/* A share link needs no sign-in: its token is the access. */}
      <If when={shared()}
        else={
          <If when={auth().status !== "loading"} else={<Loading />}>
            <If when={signedIn()} else={<SignIn />}>
              <Shell />
            </If>
          </If>
        }>
        {token => <Each of={[token()]} key={value => value}>{value => <SharedSession token={value()} />}</Each>}
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
  /** The session beside the sidebar in the wide layout; none shows the new-session home there. */
  const selected = signal<string | null>(null);
  /** The workspace the wide layout's home starts a session in, when a link named one. */
  const homeWorkspace = signal<string | undefined>(undefined);
  /** Bumped to start the home's form afresh (a new session after another, a link to a workspace's new session). */
  const homeKey = signal(0);

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
  /** A new session: the wide layout's home, or a page of its own on phones. */
  function startNew(workspaceId?: string) {
    if (wide()) {
      nav.popToRoot();
      homeWorkspace.set(workspaceId);
      selected.set(null);
      homeKey.update(value => value + 1);
    } else {
      nav.push({ name: "new", ...(workspaceId ? { workspaceId } : {}) });
    }
  }
  function openSettings(section?: string, id?: string) {
    const top = untracked(nav.routes).at(-1);
    if (wide()) {
      const route: Route = { name: "settings", ...(section ? { section } : {}), ...(id ? { id } : {}) };
      if (top?.name === "settings") nav.replace(route);
      else nav.push(route);
    } else if (section) {
      if (top?.name !== "settings") nav.push({ name: "settings" });
      nav.push({ name: "settings-section", section, ...(id ? { id } : {}) });
    } else {
      nav.push({ name: "settings" });
    }
  }
  /** Goes where a link points: the address the app was opened at, a link inside the app. */
  function go(route: PageRoute) {
    switch (route.name) {
      case "home": nav.popToRoot(); break;
      case "session": nav.popToRoot(); openSession(route.sessionId); break;
      case "new": nav.popToRoot(); startNew(route.workspaceId); break;
      case "settings": nav.popToRoot(); openSettings(route.section, route.id); break;
      case "join": nav.popToRoot(); nav.push({ name: "join", token: route.token }); break;
      case "shared": break;
    }
  }
  // The address the page was opened at, and any the user goes to by editing it or following a link.
  effect(() => {
    const route = pageRoute();
    untracked(() => go(route));
  });
  // The address follows where the app is, so it can be shared or bookmarked.
  effect(() => {
    const top = nav.routes().at(-1);
    const beside = selected();
    untracked(() => {
      if (!top) return;
      switch (top.name) {
        case "session": return showRoute({ name: "session", sessionId: top.id });
        case "sessions": return showRoute(beside && wide() ? { name: "session", sessionId: beside } : { name: "home" });
        case "new": return showRoute(top.workspaceId ? { name: "new", workspaceId: top.workspaceId } : { name: "home" });
        case "settings": case "settings-section": return showRoute({ name: "settings", ...(top.section ? { section: top.section } : {}), ...(top.id ? { id: top.id } : {}) });
        case "join": return showRoute({ name: "join", token: top.token });
        default: return showRoute({ name: "home" });
      }
    });
  });
  // A window narrowed while a session is open beside the sidebar keeps it open, as its own page; widened, the page goes
  // back beside the sidebar. A new-session page becomes the wide layout's home the same way.
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
      } else if (isWide && top?.name === "new") {
        nav.popToRoot();
        homeWorkspace.set(top.workspaceId);
        selected.set(null);
      }
    });
  });

  const back = () => nav.pop();
  const listActions = () => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
      <IconButton testID="open-by-id" icon="hash" label="Open a session by ID" onPress={() => nav.push({ name: "open" })} />
      <IconButton testID="new-session" icon="compose" label="New session" onPress={() => startNew()} active />
    </View>
  );
  const settingsButton = () => <IconButton testID="open-settings" icon="settings" label="Settings" onPress={() => openSettings()} />;

  return (
    <AppDataContext.Provider value={data}>
      <NavStack state={nav} style={{ flex: 1 }} testID="nav">
        {route => {
          switch (route.name) {
            case "sessions":
              return (
                <If when={wide()}
                  else={
                    <NavPage title="Sessions" {...headerProps({ title: "Sessions", leading: drawsHeaders ? <Logo size={22} /> : settingsButton(), actions: drawsHeaders ? <>{listActions()}{settingsButton()}</> : listActions() })}>
                      <SessionList onOpen={openSession} onNew={() => startNew()} />
                    </NavPage>
                  }>
                  <NavPage title="Pikibun" headerVisible={false} header={drawsHeaders ? <View /> : undefined}>
                    <View style={{ flex: 1, flexDirection: "row" }}>
                      <Sidebar selectedId={selected()} home={!selected()} onOpen={openSession} onNew={() => startNew()}
                        onOpenById={() => nav.push({ name: "open" })} onSettings={() => openSettings()} />
                      <View style={{ flex: 1, backgroundColor: palette().background }}>
                        <If when={selected()}
                          else={
                            <Each of={[homeKey()]} key={value => String(value)}>
                              {() => <NewSessionForm home workspaceId={untracked(homeWorkspace)} onStarted={openFromPage} />}
                            </Each>
                          }>
                          {/* Keyed by id: another session is another view, with its own stream, drafts and picks. */}
                          <Each of={selected() ? [selected()!] : []} key={id => id}>
                            {id => <SessionView id={id()} page={false} openSession={openSession} go={go} />}
                          </Each>
                        </If>
                      </View>
                    </View>
                  </NavPage>
                </If>
              );
            case "session":
              return <SessionView id={route.id} page openSession={openSession} onBack={back} go={go} />;
            case "new":
              return (
                <NavPage title="New session" {...headerProps({ title: "New session", onBack: back })}>
                  <NewSessionForm workspaceId={route.workspaceId} onStarted={openFromPage} />
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
                  <SettingsPage section={route.section} id={route.id} wide={wide()} onOpen={id => openSettings(id)} go={go} />
                </NavPage>
              );
            case "settings-section": {
              const section = findSection(route.section);
              return (
                <NavPage title={section.label} {...headerProps({ title: section.label, onBack: back })}>
                  <section.Component id={route.id} go={go} />
                </NavPage>
              );
            }
            case "join":
              return (
                <NavPage title="Join a workspace" {...headerProps({ title: "Join a workspace", onBack: back })}>
                  <JoinWorkspace token={route.token} onDone={() => nav.popToRoot()} />
                </NavPage>
              );
          }
        }}
      </NavStack>
    </AppDataContext.Provider>
  );
}

/** One of the sidebar's places: an icon and a label, highlighted while it is shown. */
function SidebarItem(props: { icon: IconName; label: string; onPress: () => void; active?: boolean; testID?: string }) {
  return (
    <BaseButton testID={props.testID} accessibilityLabel={props.label} selected={props.active} onPress={props.onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, height: 34, borderRadius: radius.medium,
        backgroundColor: props.active ? palette().selection : "transparent" }}
      hoverStyle={{ backgroundColor: props.active ? palette().selection : palette().hover }} activeStyle={{ opacity: 0.7 }}>
      <Icon name={props.icon} size={16} color={palette().text} />
      <Text style={{ flex: 1, fontSize: text.body, fontWeight: "500", color: palette().text }}>{props.label}</Text>
    </BaseButton>
  );
}

/** The wide layout's sidebar: the app, a new session, every session by workspace, and the signed-in person's settings. */
function Sidebar(props: { selectedId: string | null; home: boolean; onOpen: (id: string) => void; onNew: () => void; onOpenById: () => void; onSettings: () => void }) {
  const user = () => session().user;
  return (
    <View testID="sidebar" style={{ width: 280, paddingTop: safeArea().top, backgroundColor: palette().sidebar, borderRightWidth: 1, borderColor: palette().border }}>
      <View desktop={{ windowDrag: true }} style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 52, paddingLeft: 16, paddingRight: 8 }}>
        <Logo size={22} />
        <Text style={{ flex: 1, fontSize: text.title, fontWeight: "700", color: palette().text }}>Pikibun</Text>
        <IconButton testID="open-by-id" icon="hash" label="Open a session by ID" onPress={props.onOpenById} />
      </View>
      <View style={{ paddingHorizontal: 8, paddingBottom: 8 }}>
        <SidebarItem testID="new-session" icon="compose" label="New session" active={props.home} onPress={props.onNew} />
      </View>
      <SessionList compact selectedId={props.selectedId} onOpen={props.onOpen} onNew={props.onNew} />
      <View style={{ borderTopWidth: 1, borderColor: palette().border, padding: 8, paddingBottom: Math.max(8, safeArea().bottom) }}>
        <BaseButton testID="open-settings" accessibilityLabel="Settings" onPress={props.onSettings}
          style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 8, height: 42, borderRadius: radius.medium }}
          hoverStyle={{ backgroundColor: palette().hover }} activeStyle={{ opacity: 0.7 }}>
          <Avatar name={user().displayName || user().githubLogin || "?"} size={26} />
          <View style={{ flex: 1, gap: 1 }}>
            <Text style={{ fontSize: text.body, fontWeight: "500", color: palette().text, numberOfLines: 1 }}>{user().displayName || user().githubLogin}</Text>
            <If when={user().githubLogin}>
              {login => <Text style={{ fontSize: text.caption, color: palette().muted, numberOfLines: 1 }}>{`@${login()}`}</Text>}
            </If>
          </View>
          <Icon name="settings" size={16} color={palette().muted} />
        </BaseButton>
      </View>
    </View>
  );
}

/** The settings: the sections, and in the wide layout the chosen one beside them. */
function SettingsPage(props: { section?: string; id?: string; wide: boolean; onOpen: (section: string) => void; go: (route: PageRoute) => void }) {
  const current = () => findSection(props.section);
  return (
    <If when={props.wide} else={<SectionList onOpen={props.onOpen} />}>
      <View style={{ flex: 1, flexDirection: "row" }}>
        <View style={{ width: 240, borderRightWidth: 1, borderColor: palette().border, backgroundColor: palette().sidebar }}>
          <SectionList selected={current().id} onOpen={props.onOpen} />
        </View>
        <View style={{ flex: 1 }}>
          {/* Keyed by section and item: each is made when it is chosen. */}
          <Each of={[`${current().id}\u0000${props.id ?? ""}`]} key={value => value}>
            {() => {
              const section = untracked(current);
              return <section.Component id={untracked(() => props.id)} go={props.go} />;
            }}
          </Each>
        </View>
      </View>
    </If>
  );
}
