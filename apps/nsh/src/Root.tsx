import { computed, effect, safeArea, signal, untracked, View, windowSize } from "nsh";
import { createNavStack, NavPage, NavStack } from "nsh/base";
import { SidebarUpdate, UpdateIconButton } from "./components/AppUpdate";
import { NewWorkspaceSheet } from "./components/NewWorkspaceSheet";
import { AppDataContext, createAppData } from "./lib/app-data";
import { startUpdateChecks } from "./lib/app-update";
import { auth, restore, session } from "./lib/auth";
import { createNotificationDelivery } from "./lib/notifications";
import { pageRoute, showRoute, startPage, type PageRoute } from "./lib/page";
import { usesBrowserSession } from "./lib/server";
import { takeRememberedInvite, takeReturn } from "./lib/sign-in-memory";
import { resumeThisComputer } from "./lib/this-computer";
import { JoinWorkspace } from "./screens/JoinWorkspace";
import { NewSessionForm } from "./screens/NewSession";
import { OpenSession } from "./screens/OpenSession";
import { drawsHeaders, headerInPage, Page, pageStyle } from "./screens/PageHeader";
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
  | { name: "all-sessions" }
  | { name: "settings" }
  | { name: "settings-section"; section: string; id?: string }
  | { name: "join"; token: string };

const WIDE = 700;

export function Root() {
  startPage();
  void applyStoredAppearance();
  void restore();
  resumeThisComputer();
  startUpdateChecks();
  const signedIn = () => auth().status === "signedIn";
  const shared = () => {
    const route = pageRoute();
    return route.name === "shared" ? route.token : null;
  };
  const invite = () => {
    const route = pageRoute();
    return route.name === "join" ? route.token : undefined;
  };
  return (
    <View style={{ flex: 1, backgroundColor: palette().background }}>
      <If when={shared()}
        else={
          <If when={auth().status !== "loading"} else={<Loading />}>
            <If when={signedIn()} else={<SignIn inviteToken={invite()} />}>
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

function Shell() {
  const data = createAppData();
  createNotificationDelivery(untracked(session).user.id);
  const nav = createNavStack<Route>([{ name: "sessions" }]);
  let lastWidth = 0;
  const width = computed(() => {
    const current = windowSize().width;
    if (current > 0) lastWidth = current;
    return lastWidth;
  });
  const wide = () => width() >= WIDE;
  const selected = signal<string | null>(null);
  const homeWorkspace = signal<string | undefined>(undefined);
  const homeKey = signal(0);
  const settingsAt = signal<{ section?: string; id?: string }>({});
  const creatingWorkspace = signal(false);

  function openSession(id: string) {
    if (wide()) {
      selected.set(id);
      nav.popToRoot();
    } else {
      nav.push({ name: "session", id });
    }
  }
  function openFromPage(id: string) {
    if (wide()) {
      nav.popToRoot();
      selected.set(id);
    } else {
      nav.replace({ name: "session", id });
    }
  }
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
  effect(() => {
    const route = pageRoute();
    untracked(() => go(route));
  });
  if (usesBrowserSession) {
    void Promise.all([takeRememberedInvite(), takeReturn()]).then(([token, back]) => {
      const at = untracked(pageRoute);
      if (token && at.name !== "join") go({ name: "join", token });
      else if (back && at.name === "home") go(back);
    });
  }
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
      <UpdateIconButton onOpen={() => openSettings("profile")} />
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
                    <Page title="Sessions" leading={drawsHeaders ? <Logo size={22} /> : settingsButton()} actions={drawsHeaders ? <>{listActions()}{settingsButton()}</> : listActions()}>
                      <SessionList onOpen={openSession} onNew={() => startNew()} onNewIn={startNew} onWorkspaceSettings={workspaceSettings}
                        onNewWorkspace={() => creatingWorkspace.set(true)} />
                    </Page>
                  }>
                  <NavPage title="Pikibun" headerVisible={false} header={drawsHeaders ? <View /> : undefined} style={pageStyle()}>
                    <View style={{ flex: 1, flexDirection: "row" }}>
                      <Sidebar selectedId={selected()} home={!selected()} onOpen={openSession} onNew={() => startNew()}
                        onOpenById={() => nav.push({ name: "open" })} onAll={() => nav.push({ name: "all-sessions" })} onSettings={section => openSettings(section)}
                        onNewIn={startNew} onWorkspaceSettings={workspaceSettings} onNewWorkspace={() => creatingWorkspace.set(true)} />
                      <View style={{ flex: 1, paddingTop: headerInPage ? safeArea().top : 0, backgroundColor: palette().background }}>
                        <If when={selected()}
                          else={
                            <Each of={[homeKey()]} key={value => String(value)}>
                              {() => <NewSessionForm home workspaceId={untracked(homeWorkspace)} onStarted={openFromPage} go={go} />}
                            </Each>
                          }>
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
                <Page title="New session" onBack={back}>
                  <NewSessionForm workspaceId={route.workspaceId} onStarted={openFromPage} go={go} />
                </Page>
              );
            case "all-sessions":
              return (
                <Page title="Sessions" onBack={back}>
                  <Sessions onOpen={openFromPage} onOpenById={() => nav.push({ name: "open" })} onNew={() => startNew()} />
                </Page>
              );
            case "open":
              return (
                <Page title="Open a session" onBack={back}>
                  <OpenSession onOpen={openFromPage} />
                </Page>
              );
            case "settings":
              return (
                <Page title="Settings" onBack={back}>
                  <SettingsPage section={settingsAt().section} id={settingsAt().id} wide={wide()} onOpen={id => openSettings(id)} go={go} />
                </Page>
              );
            case "settings-section": {
              const section = findSection(route.section);
              return (
                <Page title={section.label} onBack={back}>
                  <section.Component id={route.id} go={go} />
                </Page>
              );
            }
            case "join":
              return (
                <Page title="Join a workspace" onBack={back}>
                  <JoinWorkspace token={route.token} onDone={() => nav.popToRoot()} go={go} />
                </Page>
              );
          }
        }}
      </NavStack>
      <NewWorkspaceSheet open={creatingWorkspace()} onClose={() => creatingWorkspace.set(false)} created={created => startNew(created.id)} />
    </AppDataContext.Provider>
  );
}

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
      <SidebarUpdate onDetails={() => props.onSettings("profile")} />
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

function SettingsPage(props: { section?: string; id?: string; wide: boolean; onOpen: (section: string) => void; go: (route: PageRoute) => void }) {
  const current = () => findSection(props.section);
  return (
    <If when={props.wide} else={<SectionList onOpen={props.onOpen} />}>
      <View style={{ flex: 1, flexDirection: "row" }}>
        <View style={{ width: layout.settingsList, borderRightWidth: 1, borderColor: palette().border, backgroundColor: palette().sidebar }}>
          <SectionList selected={current().id} onOpen={props.onOpen} />
        </View>
        <View style={{ flex: 1 }}>
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
