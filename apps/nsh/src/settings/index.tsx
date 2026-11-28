import { computed, safeArea, Scroll, signal, Text, View, type JSX } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { useAppData } from "../lib/app-data";
import { session } from "../lib/auth";
import { displayOrigin } from "../lib/server";
import { computerName, computerTitle, hostsHere } from "../lib/this-computer";
import { Icon, type IconName } from "../icons";
import { layout, palette, radius, text, weight } from "../theme";
import { IdentityBadge, NavItem, Row, SearchField } from "../ui";
import { Administration } from "./Administration";
import { Appearance } from "./Appearance";
import { Hosts } from "./Hosts";
import { McpSharing } from "./McpSharing";
import { Notifications } from "./Notifications";
import { Password } from "./Password";
import type { SectionProps } from "./parts";
import { Profile } from "./Profile";
import { searchSettings, type SettingsResult, type SettingsTarget } from "./search";
import { SelfHost } from "./SelfHost";
import { ThisComputer } from "./ThisComputer";
import { Workspaces } from "./Workspaces";

export type { SettingsTarget } from "./search";

export type SettingsScope = "server" | "device";

export interface SettingsSection {
  id: string;
  label: string;
  icon: IconName;
  scope: SettingsScope;
  keywords?: string[];
  admin?: boolean;
  passwords?: boolean;
  desktop?: boolean;
  Component: (props: SectionProps) => JSX.Element;
}

type ServerHealth = { passwordAuth?: boolean; version?: string | null; codeSignIn?: boolean };
const health = signal<ServerHealth | null>(null);
let askedHealth: string | null = null;
function serverHealth() {
  const { api, origin, user } = session();
  const key = `${origin} ${user.id}`;
  if (askedHealth !== key) {
    askedHealth = key;
    health.set(null);
    api<ServerHealth>("/api/health").then(value => { if (askedHealth === key) health.set(value); }, () => undefined);
  }
  return health();
}
const passwordsOffered = () => serverHealth()?.passwordAuth === true;
export const serverVersion = () => serverHealth()?.version ?? null;
export const codeSignInOffered = () => serverHealth()?.codeSignIn !== false;

export const settingsSections: readonly SettingsSection[] = [
  { id: "profile", label: "Profile", icon: "user", scope: "server", Component: Profile,
    keywords: ["Identity", "Display name", "Git author name", "Git author email", "Environment variables", "Connected accounts", "Git accounts", "Document accounts",
      "Remote MCP servers", "Signed-in apps", "Sign in an app", "Requests to join", "Servers", "Username", "User ID", "Sign out", "This app", "App updates"] },
  { id: "password", label: "Password", icon: "lock", scope: "server", passwords: true, Component: Password,
    keywords: ["Username", "Sign-in", "Change password", "Remove password"] },
  { id: "notifications", label: "Notifications", icon: "bell", scope: "server", Component: Notifications,
    keywords: ["Notifications on this device", "Notify me when", "Devices"] },
  { id: "hosts", label: "Hosts", icon: "server", scope: "server", Component: Hosts,
    keywords: ["Pair a host", "Shared with you", "Trust with my account", "Host sharing", "Host configuration", "Command time limit", "Sessions on the host", "Compaction",
      "Host admins", "Host command access", "Host models", "Host extensions", "Revoke host"] },
  { id: "workspaces", label: "Workspaces", icon: "users", scope: "server", Component: Workspaces, keywords: ["New workspace", "Deleted workspaces"] },
  { id: "mcp-sharing", label: "MCP sharing", icon: "sparkles", scope: "server", keywords: ["Share remote MCP servers", "MCP connections"], Component: McpSharing },
  { id: "admin", label: "Administration", icon: "shield", scope: "server", admin: true, Component: Administration,
    keywords: ["Server overview", "Accounts", "Every workspace", "Every host"] },
  { id: "desktop", label: "Local hosts", icon: "monitor", scope: "device", desktop: true, Component: ThisComputer,
    keywords: [computerTitle, "Add a host", "Pair this computer", "Sandbox", "WSL", "Models offered", "Sign Pi in to a provider", "Pikibun's command", "Command updates"] },
  { id: "self-host", label: "Self host", icon: "database", scope: "device", desktop: true, Component: SelfHost,
    keywords: [`Pikibun on ${computerName}`, "Start Pikibun", "Stop Pikibun"] },
  { id: "appearance", label: "Appearance", icon: "palette", scope: "device", Component: Appearance, keywords: ["Theme", "Color theme", "Dark mode", "Light mode"] },
];

export const scopes: readonly SettingsScope[] = ["server", "device"];
export const deviceTitle = hostsHere ? computerTitle : "This device";

export function scopeTitle(scope: SettingsScope): string {
  return scope === "device" ? deviceTitle : displayOrigin(session().origin);
}

export function visibleSections(shown?: string): SettingsSection[] {
  const { user } = session();
  const admin = Boolean(user.instanceAdmin);
  return settingsSections.filter(section => (!section.admin || admin) && (!section.desktop || hostsHere)
    && (!section.passwords || user.hasPassword || shown === section.id || passwordsOffered()));
}

function groups(shown?: string): { scope: SettingsScope; sections: SettingsSection[] }[] {
  const visible = visibleSections(shown);
  return scopes.map(scope => ({ scope, sections: visible.filter(section => section.scope === scope) })).filter(group => group.sections.length > 0);
}

export function findSection(id: string | undefined): SettingsSection {
  const visible = visibleSections(id);
  return visible.find(section => section.id === id) ?? visible[0]!;
}

function createSettingsSearch(shown: () => string | undefined) {
  const data = useAppData();
  const query = signal("");
  const results = computed(() => searchSettings(query(), visibleSections(shown()), data.workspaces(),
    section => scopeTitle(settingsSections.find(item => item.id === section.id)?.scope ?? "server")));
  return { query, results, searching: () => query().trim() !== "" };
}

const sameTarget = (result: SettingsResult, section: string | undefined, id: string | undefined) =>
  result.target.section === section && (result.target.id ?? undefined) === (id ?? undefined) && !result.target.tab;

function ResultLeading(props: { result: SettingsResult }) {
  return (
    <If when={props.result.workspace} else={<Icon name={props.result.icon} size={16} color={palette().muted} />}>
      {workspace => <IdentityBadge name={workspace().name} id={workspace().id} size={16} />}
    </If>
  );
}

function ServerVersion() {
  return (
    <If when={serverVersion()}>
      {version => <Text testID="settings-server-version" style={{ paddingTop: 16, paddingHorizontal: 12, fontSize: text.caption, color: palette().faint }}>{`Pikibun server ${version()}`}</Text>}
    </If>
  );
}

export function SectionList(props: { onOpen: (target: SettingsTarget) => void }) {
  const search = createSettingsSearch(() => undefined);
  const openFirst = () => { const first = search.results()[0]; if (first) props.onOpen(first.target); };
  const card = (children: JSX.Element) => (
    <View style={{ overflow: "hidden", borderRadius: radius.large, borderWidth: 1, borderColor: palette().border, backgroundColor: palette().surface }}>
      <View style={{ marginTop: -1 }}>{children}</View>
    </View>
  );
  return (
    <Scroll style={{ flex: 1 }} contentStyle={{ paddingBottom: 24 }}>
      <View testID="settings-sections" style={{ gap: 24, padding: 16 }}>
        <SearchField value={search.query()} onChange={value => search.query.set(value)} placeholder="Search settings" testID="settings-search" onSubmit={openFirst} />
        <If when={search.searching()}
          else={
            <Each of={groups()} key={group => group.scope}>
              {group => (
                <View testID={`settings-group-${group().scope}`} style={{ gap: 8 }}>
                  <Text role="header" testID={`settings-group-title-${group().scope}`}
                    style={{ paddingHorizontal: 4, fontSize: text.small, fontWeight: weight.medium, color: palette().muted }}>{scopeTitle(group().scope)}</Text>
                  {card(
                    <Each of={group().sections} key={section => section.id}>
                      {section => (
                        <Row testID={`settings-section-${section().id}`} title={section().label} chevron onPress={() => props.onOpen({ section: section().id })}
                          leading={<Icon name={section().icon} size={16} color={palette().muted} />} />
                      )}
                    </Each>,
                  )}
                </View>
              )}
            </Each>
          }>
          <If when={search.results().length}
            else={<Text testID="settings-search-empty" style={{ paddingHorizontal: 4, fontSize: text.small, color: palette().muted }}>No setting matches</Text>}>
            {card(
              <Each of={search.results()} key={result => result.key}>
                {result => (
                  <Row testID={`settings-result-${result().key}`} title={result().title} hint={result().hint} chevron onPress={() => props.onOpen(result().target)}
                    leading={<ResultLeading result={result()} />} />
                )}
              </Each>,
            )}
          </If>
        </If>
        <ServerVersion />
      </View>
    </Scroll>
  );
}

function SidebarHeading(props: { children: string; testID?: string }) {
  return (
    <Text role="header" testID={props.testID}
      style={{ paddingTop: 14, paddingHorizontal: 8, paddingBottom: 4, fontSize: text.caption, fontWeight: weight.medium, color: palette().faint }}>{props.children}</Text>
  );
}

function ResultItem(props: { result: SettingsResult; active: boolean; onPress: () => void }) {
  return (
    <BaseButton testID={`settings-result-${props.result.key}`} accessibilityLabel={`${props.result.title}, ${props.result.hint}`} selected={props.active} onPress={props.onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 40, paddingHorizontal: 8, paddingVertical: 5, borderRadius: radius.medium,
        backgroundColor: props.active ? palette().selection : "transparent" }}
      hoverStyle={{ backgroundColor: props.active ? palette().selection : palette().hover }} activeStyle={{ opacity: 0.7 }}>
      <ResultLeading result={props.result} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text style={{ numberOfLines: 1, fontSize: text.body, color: palette().text }}>{props.result.title}</Text>
        <Text style={{ numberOfLines: 1, fontSize: text.caption, color: palette().muted }}>{props.result.hint}</Text>
      </View>
    </BaseButton>
  );
}

export function SettingsSidebar(props: { section: string; id?: string; onOpen: (target: SettingsTarget) => void; onBack: () => void }) {
  const data = useAppData();
  const search = createSettingsSearch(() => props.section);
  const openFirst = () => { const first = search.results()[0]; if (first) props.onOpen(first.target); };
  return (
    <View testID="settings-sidebar" style={{ width: layout.sidebar, paddingTop: safeArea().top, backgroundColor: palette().sidebar, borderRightWidth: 1, borderColor: palette().border }}>
      <View desktop={{ windowDrag: true }} style={{ gap: 2, paddingTop: 12, paddingHorizontal: 8, paddingBottom: 4 }}>
        <NavItem testID="settings-back" icon="arrow-left" label="Back to app" onPress={props.onBack} />
      </View>
      <View style={{ paddingHorizontal: 8, paddingTop: 4, paddingBottom: 4 }}>
        <SearchField compact value={search.query()} onChange={value => search.query.set(value)} placeholder="Search settings" testID="settings-search" onSubmit={openFirst} />
      </View>
      <Scroll style={{ flex: 1 }} contentStyle={{ paddingHorizontal: 8, paddingBottom: 16 }}>
        <If when={search.searching()}
          else={
            <View testID="settings-sections" style={{ gap: 2 }}>
              <Each of={groups(props.section)} key={group => group.scope}>
                {group => (
                  <View testID={`settings-group-${group().scope}`} style={{ gap: 2 }}>
                    <SidebarHeading testID={`settings-group-title-${group().scope}`}>{scopeTitle(group().scope)}</SidebarHeading>
                    <Each of={group().sections} key={section => section.id}>
                      {section => (
                        <>
                          <NavItem testID={`settings-section-${section().id}`} icon={section().icon} label={section().label}
                            active={props.section === section().id && !(section().id === "workspaces" && props.id)} onPress={() => props.onOpen({ section: section().id })} />
                          <If when={section().id === "workspaces"}>
                            <Each of={data.workspaces()} key={workspace => workspace.id}>
                              {workspace => (
                                <NavItem testID={`settings-workspace-${workspace().id}`} label={workspace().name} style={{ paddingLeft: 32, minHeight: 30, paddingVertical: 4 }}
                                  leading={<IdentityBadge name={workspace().name} id={workspace().id} size={16} />}
                                  active={props.section === "workspaces" && props.id === workspace().id}
                                  onPress={() => props.onOpen({ section: "workspaces", id: workspace().id })} />
                              )}
                            </Each>
                          </If>
                        </>
                      )}
                    </Each>
                  </View>
                )}
              </Each>
              <ServerVersion />
            </View>
          }>
          <View testID="settings-results" style={{ gap: 2, paddingTop: 8 }}>
            <If when={search.results().length}
              else={<Text testID="settings-search-empty" style={{ padding: 8, fontSize: text.small, color: palette().muted }}>No setting matches</Text>}>
              <Each of={search.results()} key={result => result.key}>
                {result => <ResultItem result={result()} active={sameTarget(result(), props.section, props.id)} onPress={() => props.onOpen(result().target)} />}
              </Each>
            </If>
          </View>
        </If>
      </Scroll>
    </View>
  );
}
