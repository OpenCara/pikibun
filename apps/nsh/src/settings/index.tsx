import { Text, View, type JSX } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { session } from "../lib/auth";
import { palette } from "../theme";
import { Administration } from "./Administration";
import { Appearance } from "./Appearance";
import { Hosts } from "./Hosts";
import type { SectionProps } from "./parts";
import { Profile } from "./Profile";
import { Workspaces } from "./Workspaces";

export interface SettingsSection {
  /** The address's name for it (`#/settings/<id>`), as the web app had them. */
  id: string;
  label: string;
  icon: string;
  /** Only the server's administrators see it. */
  admin?: boolean;
  Component: (props: SectionProps) => JSX.Element;
}

/** Every section, in order. A section ported from the web app replaces its file's placeholder; nothing else changes. */
export const settingsSections: readonly SettingsSection[] = [
  { id: "profile", label: "Profile", icon: "◉", Component: Profile },
  { id: "workspaces", label: "Workspaces", icon: "👥", Component: Workspaces },
  { id: "hosts", label: "Hosts", icon: "🖥", Component: Hosts },
  { id: "appearance", label: "Appearance", icon: "◐", Component: Appearance },
  { id: "admin", label: "Administration", icon: "🛡", admin: true, Component: Administration },
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

/** The list of sections; `selected` marks the one shown beside it in the wide layout. */
export function SectionList(props: { selected?: string; onOpen: (id: string) => void }) {
  return (
    <View testID="settings-sections" style={{ paddingVertical: 8 }}>
      <Each of={visibleSections()} key={section => section.id}>
        {section => (
          <BaseButton testID={`settings-section-${section().id}`} selected={props.selected === section().id} onPress={() => props.onOpen(section().id)}
            style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12,
              backgroundColor: props.selected === section().id ? palette().selection : "transparent" }}
            activeStyle={{ backgroundColor: palette().selection }} hoverStyle={{ backgroundColor: palette().surfaceRaised }}>
            <Text style={{ width: 22, fontSize: 16, color: palette().muted }}>{section().icon}</Text>
            <Text style={{ flex: 1, fontSize: 16, color: palette().text }}>{section().label}</Text>
            <Text style={{ fontSize: 16, color: palette().muted }}>›</Text>
          </BaseButton>
        )}
      </Each>
    </View>
  );
}
