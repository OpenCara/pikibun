import { signal, Text, View, type JSX } from "nsh";
import { session } from "../lib/auth";
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
import { Workspaces } from "./Workspaces";

export interface SettingsSection {
  /** The address's name for it (`#/settings/<id>`), as the web app had them. */
  id: string;
  label: string;
  icon: IconName;
  /** Only the server's administrators see it. */
  admin?: boolean;
  /** Only where the server takes passwords, or the account still has one to remove. */
  passwords?: boolean;
  Component: (props: SectionProps) => JSX.Element;
}

/** Whether the server takes passwords (its health check), asked once per sign-in. */
const passwordAuth = signal(false);
let askedPasswordAuth: string | null = null;
function passwordsOffered(): boolean {
  const { api, origin, user } = session();
  const key = `${origin} ${user.id}`;
  if (askedPasswordAuth !== key) {
    askedPasswordAuth = key;
    api<{ passwordAuth?: boolean }>("/api/health").then(health => passwordAuth.set(health.passwordAuth === true), () => undefined);
  }
  return passwordAuth();
}

/** Every section, in order. A section ported from the web app replaces its file's placeholder; nothing else changes. */
export const settingsSections: readonly SettingsSection[] = [
  { id: "profile", label: "Profile", icon: "user", Component: Profile },
  { id: "password", label: "Password", icon: "lock", passwords: true, Component: Password },
  { id: "notifications", label: "Notifications", icon: "bell", Component: Notifications },
  { id: "hosts", label: "Hosts", icon: "server", Component: Hosts },
  { id: "workspaces", label: "Workspaces", icon: "users", Component: Workspaces },
  { id: "appearance", label: "Appearance", icon: "palette", Component: Appearance },
  { id: "admin", label: "Administration", icon: "shield", admin: true, Component: Administration },
];

/** The sections this person sees; `shown`, a section the address names, stays listed. */
export function visibleSections(shown?: string): SettingsSection[] {
  const { user } = session();
  const admin = Boolean(user.instanceAdmin);
  return settingsSections.filter(section => (!section.admin || admin)
    && (!section.passwords || user.hasPassword || shown === section.id || passwordsOffered()));
}

export function findSection(id: string | undefined): SettingsSection {
  const visible = visibleSections(id);
  return visible.find(section => section.id === id) ?? visible[0]!;
}

/**
 * The list of sections; `selected` marks the one shown beside it in the wide layout (the web's .settings-list). On a
 * phone each is a row that opens its own page.
 */
export function SectionList(props: { selected?: string; onOpen: (id: string) => void }) {
  return (
    <If when={props.selected !== undefined}
      else={
        <View testID="settings-sections" style={{ padding: 16 }}>
          <View style={{ overflow: "hidden", borderRadius: radius.large, borderWidth: 1, borderColor: palette().border, backgroundColor: palette().surface }}>
            <View style={{ marginTop: -1 }}>
              <Each of={visibleSections()} key={section => section.id}>
                {section => (
                  <Row testID={`settings-section-${section().id}`} title={section().label} chevron onPress={() => props.onOpen(section().id)}
                    leading={<Icon name={section().icon} size={16} color={palette().muted} />} />
                )}
              </Each>
            </View>
          </View>
        </View>
      }>
      <View testID="settings-sections" style={{ gap: 2, paddingVertical: 16, paddingHorizontal: 8 }}>
        <Text style={{ paddingTop: 8, paddingHorizontal: 12, paddingBottom: 12, fontSize: text.small, fontWeight: weight.medium, color: palette().muted }}>Settings</Text>
        <Each of={visibleSections(props.selected)} key={section => section.id}>
          {section => (
            <NavItem testID={`settings-section-${section().id}`} icon={section().icon} label={section().label} active={props.selected === section().id}
              onPress={() => props.onOpen(section().id)} />
          )}
        </Each>
      </View>
    </If>
  );
}
