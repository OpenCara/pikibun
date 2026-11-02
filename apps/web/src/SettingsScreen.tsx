import { useApp } from "./app-context";
import { desktopBridge } from "./desktop";
import { Icon, type IconName } from "./icons";
import { href, type SettingsSection } from "./router";
import { AdminSettings } from "./settings/AdminSettings";
import { AppearanceSettings } from "./settings/AppearanceSettings";
import { DesktopSettings } from "./settings/DesktopSettings";
import { HostsSettings } from "./settings/HostsSettings";
import { ProfileSettings } from "./settings/ProfileSettings";
import { WorkspacesSettings } from "./settings/WorkspacesSettings";
import { ScreenHeader } from "./ui";

const sections: { id: SettingsSection; label: string; icon: IconName; admin?: true; desktop?: true }[] = [
  { id: "profile", label: "Profile", icon: "user" },
  { id: "hosts", label: "Hosts", icon: "server" },
  // Only in the Pikibun desktop app: its own settings (servers, this computer as a host, Pikibun on this computer).
  { id: "desktop", label: "This Computer", icon: "monitor", desktop: true },
  { id: "workspaces", label: "Workspaces", icon: "users" },
  { id: "appearance", label: "Appearance", icon: "palette" },
  // Only the server's administrators (ADMIN_USER_IDS) see this; the API refuses everyone else.
  { id: "admin", label: "Administration", icon: "shield", admin: true },
];

const desktopLabel = () => /Mac/i.test(navigator.platform) ? "This Mac" : "This Computer";

/** List + detail: a section list beside a centered 720px detail column; stacked on compact screens. */
export function SettingsScreen({ section, id }: { section: SettingsSection; id?: string }) {
  const { user } = useApp();
  const desktop = Boolean(desktopBridge());
  const visible = sections.filter(item => (!item.admin || user.instanceAdmin) && (!item.desktop || desktop))
    .map(item => item.desktop ? { ...item, label: desktopLabel() } : item);
  const current = visible.find(item => item.id === section) ?? visible[0];
  return <div className="settings-shell">
    <nav className="settings-list" aria-label="Settings">
      <div className="settings-list-title">Settings</div>
      {visible.map(item => <a key={item.id} className="nav-item" href={href({ name: "settings", section: item.id })} aria-current={item.id === current.id ? "page" : undefined}>
        <Icon name={item.icon} /><span className="label">{item.label}</span>
      </a>)}
    </nav>
    <div className="settings-detail">
      <ScreenHeader title={current.label} />
      <div className="content-column">
        {current.id === "profile" ? <ProfileSettings />
          : current.id === "hosts" ? <HostsSettings id={id} />
          : current.id === "desktop" ? <DesktopSettings />
          : current.id === "workspaces" ? <WorkspacesSettings id={id} />
          : current.id === "admin" ? <AdminSettings />
          : <AppearanceSettings />}
      </div>
    </div>
  </div>;
}
