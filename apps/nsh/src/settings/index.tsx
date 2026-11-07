import { Text, View, type JSX } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { session } from "../lib/auth";
import { Icon, type IconName } from "../icons";
import { palette, radius, text } from "../theme";
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
  icon: IconName;
  /** Only the server's administrators see it. */
  admin?: boolean;
  Component: (props: SectionProps) => JSX.Element;
}

/** Every section, in order. A section ported from the web app replaces its file's placeholder; nothing else changes. */
export const settingsSections: readonly SettingsSection[] = [
  { id: "profile", label: "Profile", icon: "user", Component: Profile },
  { id: "workspaces", label: "Workspaces", icon: "users", Component: Workspaces },
  { id: "hosts", label: "Hosts", icon: "monitor", Component: Hosts },
  { id: "appearance", label: "Appearance", icon: "contrast", Component: Appearance },
  { id: "admin", label: "Administration", icon: "shield-check", admin: true, Component: Administration },
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
    <View testID="settings-sections" style={{ gap: 2, padding: 8 }}>
      <Each of={visibleSections()} key={section => section.id}>
        {section => (
          <BaseButton testID={`settings-section-${section().id}`} selected={props.selected === section().id} onPress={() => props.onOpen(section().id)}
            style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, height: props.selected === undefined ? 44 : 34, borderRadius: radius.medium,
              backgroundColor: props.selected === section().id ? palette().selection : "transparent" }}
            activeStyle={{ backgroundColor: palette().selection }} hoverStyle={{ backgroundColor: props.selected === section().id ? palette().selection : palette().hover }}>
            <Icon name={section().icon} size={16} color={props.selected === section().id ? palette().text : palette().muted} />
            <Text style={{ flex: 1, fontSize: props.selected === undefined ? text.reading : text.body, fontWeight: "500", color: palette().text }}>{section().label}</Text>
            <If when={props.selected === undefined}>
              <Icon name="chevron-right" size={16} color={palette().faint} />
            </If>
          </BaseButton>
        )}
      </Each>
    </View>
  );
}
