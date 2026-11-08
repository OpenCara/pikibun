import { Text, View, type JSX } from "nsh";
import { session } from "../lib/auth";
import { Icon, type IconName } from "../icons";
import { palette, radius, text, weight } from "../theme";
import { NavItem, Row } from "../ui";
import { Administration } from "./Administration";
import { Appearance } from "./Appearance";
import { Hosts } from "./Hosts";
import { Notifications } from "./Notifications";
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
  Component: (props: SectionProps) => JSX.Element;
}

/** Every section, in order. A section ported from the web app replaces its file's placeholder; nothing else changes. */
export const settingsSections: readonly SettingsSection[] = [
  { id: "profile", label: "Profile", icon: "user", Component: Profile },
  { id: "notifications", label: "Notifications", icon: "bell", Component: Notifications },
  { id: "hosts", label: "Hosts", icon: "server", Component: Hosts },
  { id: "workspaces", label: "Workspaces", icon: "users", Component: Workspaces },
  { id: "appearance", label: "Appearance", icon: "palette", Component: Appearance },
  { id: "admin", label: "Administration", icon: "shield", admin: true, Component: Administration },
];

/** The sections this person sees. */
export function visibleSections(): SettingsSection[] {
  const admin = Boolean(session().user.instanceAdmin);
  return settingsSections.filter(section => !section.admin || admin);
}

export function findSection(id: string | undefined): SettingsSection {
  const visible = visibleSections();
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
        <Each of={visibleSections()} key={section => section.id}>
          {section => (
            <NavItem testID={`settings-section-${section().id}`} icon={section().icon} label={section().label} active={props.selected === section().id}
              onPress={() => props.onOpen(section().id)} />
          )}
        </Each>
      </View>
    </If>
  );
}
