import { computed, effect, safeArea, signal, untracked, View, windowSize } from "nsh";
import { createNavStack, NavPage, NavStack } from "nsh/base";
import { NewWorkspaceSheet } from "./components/NewWorkspaceSheet";
import { AppDataContext, createAppData } from "./lib/app-data";
import { auth, restore, session } from "./lib/auth";
import { pageRoute, showRoute, startPage, type PageRoute } from "./lib/page";
import { usesBrowserSession } from "./lib/server";
import { takeRememberedInvite, takeReturn } from "./lib/sign-in-memory";
import { JoinWorkspace } from "./screens/JoinWorkspace";
import { NewSessionForm } from "./screens/NewSession";
import { OpenSession } from "./screens/OpenSession";
import { drawsHeaders, headerProps, pageStyle } from "./screens/PageHeader";
import { SessionList } from "./screens/SessionList";
import { Sessions } from "./screens/Sessions";
import { SessionView } from "./screens/SessionView";
import { SharedSession } from "./screens/SharedSession";
import { SignIn } from "./screens/SignIn";
import { UsernameSetup } from "./screens/UsernameSetup";
import { applyStoredAppearance } from "./settings/Appearance";
import { findSection, SectionList } from "./settings";
import { layout, palette } from "./theme";
import { IconButton, IdentityBadge, Loading, Logo, NavItem } from "./ui";

type Route =
  | { name: "sessions" }
  | { name: "session"; id: string }
  | { name: "new"; workspaceId?: string }
  | { name: "open" }
  /** Every session, searchable (the web app's Sessions screen). */
  | { name: "all-sessions" }
  /** The sections, with the one `settingsAt` names beside them in the wide layout. */
  | { name: "settings" }
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
  /** An invite link opened while signed out: signing in asks to join its workspace. */
  const invite = () => {
    const route = pageRoute();
    return route.name === "join" ? route.token : undefined;
  };
  return (
    <View style={{ flex: 1, backgroundColor: palette().background }}>
      {/* A share link needs no sign-in: its token is the access. */}
      <If when={shared()}
        else={
          <If when={auth().status !== "loading"} else={<Loading />}>
            <If when={signedIn()} else={<SignIn inviteToken={invite()} />}>
              {/* A new GitHub account chooses its username before anything else; the route waits, invite links included. */}
              <If when={!(auth().status === "signedIn" && (auth() as { user: { usernameRequired?: boolean } }).user.usernameRequired)} else={<UsernameSetup />}>
                <Shell />
              </If>
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
  /**
   * The section (and item) the wide layout's settings show beside their list. Choosing another changes it in place:
   * replacing the page slid all of Settings in again, and swallowed a Back pressed while it did.
   */
  const settingsAt = signal<{ section?: string; id?: string }>({});
  /** The New workspace sheet, from the sidebar or the session list; once created, a session starts in it. */
  const creatingWorkspace = signal(false);

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
      settingsAt.set({ ...(section ? { section } : {}), ...(id ? { id } : {}) });
      if (top?.name !== "settings") nav.push({ name: "settings" });
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
      case "sessions": nav.popToRoot(); nav.push({ name: "all-sessions" }); break;
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
  // A browser sign-in started from an invite link returns to the app's root; pick the invite up where it left off. So
  // does one started again for what needs a recent GitHub sign-in, such as setting a password: back to where it was.
  if (usesBrowserSession) {
    void Promise.all([takeRememberedInvite(), takeReturn()]).then(([token, back]) => {
      const at = untracked(pageRoute);
      if (token && at.name !== "join") go({ name: "join", token });
      else if (back && at.name === "home") go(back);
    });
  }
  // The address follows where the app is, so it can be shared or bookmarked.
  effect(() => {
    const top = nav.routes().at(-1);
    const beside = selected();
    const at = settingsAt();
    untracked(() => {
      if (!top) return;
      switch (top.name) {
        case "session": return showRoute({ name: "session", sessionId: top.id });
        case "sessions": return showRoute(beside && wide() ? { name: "session", sessionId: beside } : { name: "home" });
        case "new": return showRoute(top.workspaceId ? { name: "new", workspaceId: top.workspaceId } : { name: "home" });
        case "settings": return showRoute(wide() ? { name: "settings", ...at } : { name: "settings" });
        case "settings-section": return showRoute({ name: "settings", section: top.section, ...(top.id ? { id: top.id } : {}) });
        case "join": return showRoute({ name: "join", token: top.token });
        case "all-sessions": return showRoute({ name: "sessions" });
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
  const workspaceSettings = (workspaceId: string) => openSettings("workspaces", workspaceId);
  const listActions = () => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
      <IconButton testID="open-by-id" icon="hash" label="Open a session by ID" onPress={() => nav.push({ name: "open" })} />
      <IconButton testID="new-session" icon="plus" label="New session" onPress={() => startNew()} />
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
                      <SessionList onOpen={openSession} onNew={() => startNew()} onNewIn={startNew} onWorkspaceSettings={workspaceSettings}
                        onNewWorkspace={() => creatingWorkspace.set(true)} />
                    </NavPage>
                  }>
                  <NavPage title="Pikibun" headerVisible={false} header={drawsHeaders ? <View /> : undefined} style={pageStyle()}>
                    <View style={{ flex: 1, flexDirection: "row" }}>
                      <Sidebar selectedId={selected()} home={!selected()} onOpen={openSession} onNew={() => startNew()}
                        onOpenById={() => nav.push({ name: "open" })} onAll={() => nav.push({ name: "all-sessions" })} onSettings={section => openSettings(section)}
                        onNewIn={startNew} onWorkspaceSettings={workspaceSettings} onNewWorkspace={() => creatingWorkspace.set(true)} />
                      <View style={{ flex: 1, backgroundColor: palette().background }}>
                        <If when={selected()}
                          else={
                            <Each of={[homeKey()]} key={value => String(value)}>
                              {() => <NewSessionForm home workspaceId={untracked(homeWorkspace)} onStarted={openFromPage} go={go} />}
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
                  <NewSessionForm workspaceId={route.workspaceId} onStarted={openFromPage} go={go} />
                </NavPage>
              );
            case "all-sessions":
              return (
                <NavPage title="Sessions" {...headerProps({ title: "Sessions", onBack: back })}>
                  <Sessions onOpen={openFromPage} onOpenById={() => nav.push({ name: "open" })} onNew={() => startNew()} />
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
                  <SettingsPage section={settingsAt().section} id={settingsAt().id} wide={wide()} onOpen={id => openSettings(id)} go={go} />
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
                  <JoinWorkspace token={route.token} onDone={() => nav.popToRoot()} go={go} />
                </NavPage>
              );
          }
        }}
      </NavStack>
      <NewWorkspaceSheet open={creatingWorkspace()} onClose={() => creatingWorkspace.set(false)} created={created => startNew(created.id)} />
    </AppDataContext.Provider>
  );
}

/**
 * The wide layout's sidebar, as the web app's (Sidebar.tsx): the app, a new session and opening one by ID; every session
 * by workspace; and the signed-in person, hosts and settings along its foot.
 */
function Sidebar(props: {
  selectedId: string | null; home: boolean; onOpen: (id: string) => void; onNew: () => void; onOpenById: () => void; onAll: () => void; onSettings: (section?: string) => void;
  onNewIn: (workspaceId: string) => void; onWorkspaceSettings: (workspaceId: string) => void; onNewWorkspace: () => void;
}) {
  const user = () => session().user;
  return (
    <View testID="sidebar" style={{ width: layout.sidebar, paddingTop: safeArea().top, backgroundColor: palette().sidebar, borderRightWidth: 1, borderColor: palette().border }}>
      <View desktop={{ windowDrag: true }} style={{ gap: 2, paddingTop: 12, paddingHorizontal: 8, paddingBottom: 8 }}>
        <NavItem label="Pikibun" strong leading={<Logo size={20} />} />
        <NavItem testID="new-session" icon="plus" label="New session" active={props.home} onPress={props.onNew} />
        <NavItem testID="all-sessions" icon="history" label="Sessions" onPress={props.onAll} />
        <NavItem testID="open-by-id" icon="hash" label="Open by ID" onPress={props.onOpenById} />
      </View>
      <SessionList compact selectedId={props.selectedId} onOpen={props.onOpen} onNew={props.onNew} onNewIn={props.onNewIn} onWorkspaceSettings={props.onWorkspaceSettings}
        onNewWorkspace={props.onNewWorkspace} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 2, borderTopWidth: 1, borderColor: palette().border, padding: 8, paddingBottom: Math.max(8, safeArea().bottom) }}>
        <NavItem testID="open-profile" style={{ flex: 1 }} label={user().username || user().githubLogin ? `@${user().username || user().githubLogin}` : user().displayName}
          leading={<IdentityBadge name={user().displayName || user().githubLogin || "?"} id={user().id} />} onPress={() => props.onSettings("profile")} />
        <IconButton testID="open-hosts" icon="server" label="Hosts" onPress={() => props.onSettings("hosts")} />
        <IconButton testID="open-settings" icon="settings" label="Settings" onPress={() => props.onSettings()} />
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
        <View style={{ width: layout.settingsList, borderRightWidth: 1, borderColor: palette().border, backgroundColor: palette().sidebar }}>
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
