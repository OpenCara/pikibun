import { signal, Text, View, type JSX } from "nsh";
import { session } from "../lib/auth";
import { displayOrigin } from "../lib/server";
import { computerTitle, hostsHere } from "../lib/this-computer";
import { Icon, type IconName } from "../icons";
import { palette, radius, text, weight } from "../theme";
import { NavItem, Row } from "../ui";
import { Administration } from "./Administration";
import { Appearance } from "./Appearance";
import { Hosts } from "./Hosts";
import { Notifications } from "./Notifications";
import { Password } from "./Password";
import type { SectionProps } from "./parts";
import { Profile } from "./Profile";
import { SelfHost } from "./SelfHost";
import { ThisComputer } from "./ThisComputer";
import { Workspaces } from "./Workspaces";

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
  { id: "profile", label: "Profile", icon: "user", scope: "server", Component: Profile },
  { id: "password", label: "Password", icon: "lock", scope: "server", passwords: true, Component: Password },
  { id: "notifications", label: "Notifications", icon: "bell", scope: "server", Component: Notifications },
  { id: "hosts", label: "Hosts", icon: "server", scope: "server", Component: Hosts },
  { id: "workspaces", label: "Workspaces", icon: "users", scope: "server", Component: Workspaces },
  { id: "admin", label: "Administration", icon: "shield", scope: "server", admin: true, Component: Administration },
  { id: "desktop", label: "Local hosts", icon: "monitor", scope: "device", keywords: [computerTitle, "pair", "sandbox", "WSL"], desktop: true, Component: ThisComputer },
  { id: "self-host", label: "Self host", icon: "database", scope: "device", desktop: true, Component: SelfHost },
  { id: "appearance", label: "Appearance", icon: "palette", scope: "device", Component: Appearance },
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

export function SectionList(props: { selected?: string; onOpen: (id: string) => void }) {
  return (
    <If when={props.selected !== undefined}
      else={
        <View testID="settings-sections" style={{ gap: 24, padding: 16 }}>
          <Each of={groups()} key={group => group.scope}>
            {group => (
              <View testID={`settings-group-${group().scope}`} style={{ gap: 8 }}>
                <Text role="header" testID={`settings-group-title-${group().scope}`}
                  style={{ paddingHorizontal: 4, fontSize: text.small, fontWeight: weight.medium, color: palette().muted }}>{scopeTitle(group().scope)}</Text>
                <View style={{ overflow: "hidden", borderRadius: radius.large, borderWidth: 1, borderColor: palette().border, backgroundColor: palette().surface }}>
                  <View style={{ marginTop: -1 }}>
                    <Each of={group().sections} key={section => section.id}>
                      {section => (
                        <Row testID={`settings-section-${section().id}`} title={section().label} chevron onPress={() => props.onOpen(section().id)}
                          leading={<Icon name={section().icon} size={16} color={palette().muted} />} />
                      )}
                    </Each>
                  </View>
                </View>
              </View>
            )}
          </Each>
        </View>
      }>
      <View testID="settings-sections" style={{ gap: 2, paddingVertical: 16, paddingHorizontal: 8 }}>
        <Text style={{ paddingTop: 8, paddingHorizontal: 12, paddingBottom: 4, fontSize: text.small, fontWeight: weight.medium, color: palette().muted }}>Settings</Text>
        <Each of={groups(props.selected)} key={group => group.scope}>
          {group => (
            <View testID={`settings-group-${group().scope}`} style={{ gap: 2 }}>
              <Text role="header" testID={`settings-group-title-${group().scope}`}
                style={{ paddingTop: 12, paddingHorizontal: 12, paddingBottom: 4, fontSize: text.caption, fontWeight: weight.medium, color: palette().faint }}>{scopeTitle(group().scope)}</Text>
              <Each of={group().sections} key={section => section.id}>
                {section => (
                  <NavItem testID={`settings-section-${section().id}`} icon={section().icon} label={section().label} active={props.selected === section().id}
                    onPress={() => props.onOpen(section().id)} />
                )}
              </Each>
            </View>
          )}
        </Each>
        <If when={serverVersion()}>
          {version => <Text testID="settings-server-version" style={{ paddingTop: 16, paddingHorizontal: 12, fontSize: text.caption, color: palette().faint }}>{`Pikibun server ${version()}`}</Text>}
        </If>
      </View>
    </If>
  );
}
