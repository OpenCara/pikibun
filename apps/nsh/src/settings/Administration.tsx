import { signal, View } from "nsh";
import type { AdminHost, AdminList, AdminOverview, AdminUser, AdminWorkspace } from "../../../../packages/shared/src/admin";
import { segment, usernameWithId } from "../shared";
import { session } from "../lib/auth";
import { relativeTime } from "../lib/format";
import { createAction, createResource } from "../lib/resource";
import type { Tone } from "../theme";
import { TextField } from "../form";
import { Badge, CardBody, confirm, DropdownMenu, Feedback, IdentityBadge, Note, ResourceState, Row, Section, Small, StatusDot } from "../ui";
import { SectionPage, type SectionProps } from "./parts";

// Settings → Administration, as the web app's (settings/AdminSettings.tsx): who uses the server and what they run
// it on, never what they work on.

const count = (value: number, singular: string, plural: string) => `${value} ${value === 1 ? singular : plural}`;

/** Whether a listed item mentions every word typed, case-insensitively. */
function matches(query: string, ...fields: (string | null | undefined)[]) {
  const text = fields.filter(Boolean).join(" ").toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => text.includes(word));
}

function Truncated(props: { list: AdminList<unknown> | null }) {
  return <If when={props.list?.truncated}><CardBody><Small>{`Only the newest ${props.list?.items.length ?? 0} are listed`}</Small></CardBody></If>;
}

export function Administration(_props: SectionProps) {
  const overview = createResource<{ overview: AdminOverview }>(() => "/api/admin/overview");
  const users = createResource<AdminList<AdminUser>>(() => "/api/admin/users");
  const workspaces = createResource<AdminList<AdminWorkspace>>(() => "/api/admin/workspaces");
  const hosts = createResource<AdminList<AdminHost>>(() => "/api/admin/hosts");
  const query = signal("");
  const action = createAction();
  const totals = () => overview.data()?.overview;
  const refresh = () => { overview.refresh(); users.refresh(); hosts.refresh(); };
  async function suspend(user: AdminUser) {
    if (!await confirm({ title: "Suspend account", destructive: true, confirmLabel: "Suspend",
      message: `Suspend ${usernameWithId(user)}? They're signed out everywhere and can't sign in, their hosts are disconnected, and nobody can open the sessions they own until you unsuspend them. Nothing is deleted.` })) return;
    void action.run(async () => {
      await session().api(`/api/admin/users/${segment(user.id)}/suspend`, { method: "POST" });
      refresh();
    }, "Account suspended.");
  }
  function unsuspend(user: AdminUser) {
    void action.run(async () => {
      await session().api(`/api/admin/users/${segment(user.id)}/unsuspend`, { method: "POST" });
      refresh();
    }, "Account unsuspended. They can sign in again and their hosts reconnect.");
  }
  const shownUsers = () => (users.data()?.items ?? []).filter(user => matches(query(), user.displayName, user.githubLogin, user.id));
  const shownWorkspaces = () => (workspaces.data()?.items ?? []).filter(item => matches(query(), item.name, item.ownerName, item.ownerGithubLogin, item.ownerId, item.id));
  const shownHosts = () => (hosts.data()?.items ?? []).filter(host => matches(query(), host.name, host.ownerName, host.ownerGithubLogin, host.ownerId, host.id));
  const hostState = (host: AdminHost): [Tone, string] => (host.revokedAt ? ["danger", "Revoked"] : host.online ? ["success", "Online"] : ["neutral", "Offline"]);
  return (
    <SectionPage testID="settings-admin">
      <Section title="Overview" info="Totals for this whole Pikibun server. You administer it because its operator lists your user ID in ADMIN_USER_IDS. Administration shows who uses the server and what they run it on, never what they work on: no session titles, prompts, repositories or credentials.">
        <ResourceState inline loading={overview.loading() && !totals()} error={overview.error()} retry={overview.refresh}>
          <If when={totals()}>
            {current => (
              <>
                <Row title="Accounts" trailing={<>
                  <Small>{String(current().users)}</Small>
                  <If when={current().suspendedUsers > 0}><Badge tone="danger">{`${current().suspendedUsers} suspended`}</Badge></If>
                </>} />
                <Row title="Workspaces" trailing={String(current().workspaces)} />
                <Row title="Hosts" trailing={`${current().onlineHosts} online of ${current().hosts}`} />
                <Row title="Sessions" trailing={`${current().activeSessions} active of ${current().sessions}`} />
              </>
            )}
          </If>
        </ResourceState>
      </Section>
      <View style={{ marginBottom: -16 }}>
        <TextField value={query()} onChange={value => query.set(value)} placeholder="Filter by name, username or ID" accessibilityLabel="Filter accounts, workspaces and hosts" autoCapitalize="none" />
      </View>
      <Section title="Accounts" info={<View style={{ gap: 8 }}>
        <Note>Suspending an account signs it out everywhere, refuses its sign-ins, disconnects its hosts and closes the sessions it owns to everyone, as if it had left its workspaces. Nothing is deleted: unsuspending restores it as it was.</Note>
        <Note>Administrators can't be suspended here; remove them from ADMIN_USER_IDS first.</Note>
      </View>}>
        <ResourceState inline loading={users.loading() && !users.data()} error={users.error()} retry={users.refresh}>
          <If when={shownUsers().length} else={<CardBody><Small>{query().trim() ? "No matching accounts" : "No accounts"}</Small></CardBody>}>
            <Each of={shownUsers()} key={user => user.id}>
              {user => (
                <Row leading={<IdentityBadge name={user().displayName} id={user().id} />} title={user().displayName}
                  hint={`${usernameWithId(user())} · ${count(user().workspaces, "workspace", "workspaces")} · ${count(user().hosts, "host", "hosts")} · ${count(user().sessions, "session", "sessions")} · Joined ${relativeTime(user().createdAt)}`}
                  trailing={<>
                    <If when={user().instanceAdmin}><Badge tone="success">Administrator</Badge></If>
                    <If when={user().suspendedAt}><Badge tone="danger">Suspended</Badge></If>
                    <If when={!user().instanceAdmin}>
                      <DropdownMenu label={`Actions for ${user().displayName}`} items={[user().suspendedAt
                        ? { label: "Unsuspend", icon: "refresh", disabled: action.busy(), onSelect: () => unsuspend(user()) }
                        : { label: "Suspend", icon: "lock", destructive: true, disabled: action.busy(), onSelect: () => void suspend(user()) }]} />
                    </If>
                  </>} />
              )}
            </Each>
          </If>
          <Truncated list={users.data()} />
        </ResourceState>
        <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
      </Section>
      <Section title="Workspaces">
        <ResourceState inline loading={workspaces.loading() && !workspaces.data()} error={workspaces.error()} retry={workspaces.refresh}>
          <If when={shownWorkspaces().length} else={<CardBody><Small>{query().trim() ? "No matching workspaces" : "No workspaces"}</Small></CardBody>}>
            <Each of={shownWorkspaces()} key={item => item.id}>
              {item => (
                <Row leading={<IdentityBadge name={item().name} id={item().id} />} title={item().name}
                  hint={`Owner ${usernameWithId({ id: item().ownerId, githubLogin: item().ownerGithubLogin })} · ${count(item().members, "member", "members")} · ${count(item().repositories, "repository", "repositories")} · ${count(item().hosts, "host", "hosts")} · ${count(item().sessions, "session", "sessions")} · Created ${relativeTime(item().createdAt)}`} />
              )}
            </Each>
          </If>
          <Truncated list={workspaces.data()} />
        </ResourceState>
      </Section>
      <Section title="Hosts" info="Every paired host that hasn't been removed. A suspended account's hosts stay paired but can't connect until it is unsuspended.">
        <ResourceState inline loading={hosts.loading() && !hosts.data()} error={hosts.error()} retry={hosts.refresh}>
          <If when={shownHosts().length} else={<CardBody><Small>{query().trim() ? "No matching hosts" : "No hosts"}</Small></CardBody>}>
            <Each of={shownHosts()} key={host => host.id}>
              {host => (
                <Row leading={<StatusDot tone={hostState(host())[0]} label={hostState(host())[1]} />} title={host().name}
                  hint={`${usernameWithId({ id: host().ownerId, githubLogin: host().ownerGithubLogin })} · ${count(host().workspaces, "workspace", "workspaces")} · ${count(host().sessions, "session", "sessions")}${host().lastSeenAt ? ` · Last connected ${relativeTime(host().lastSeenAt!)}` : ""}`}
                  trailing={<Badge tone={hostState(host())[0]}>{hostState(host())[1]}</Badge>} />
              )}
            </Each>
          </If>
          <Truncated list={hosts.data()} />
        </ResourceState>
      </Section>
    </SectionPage>
  );
}
