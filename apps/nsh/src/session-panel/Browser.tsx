import { computed, effect, signal, Text, untracked, View } from "nsh";
import type { SessionFiles } from "../../../../packages/shared/src/types";
import { BROWSER_OUTPUT, BROWSER_REPORT_NAME, BROWSER_SCREENSHOT_PATH, parseBrowserReport, type BrowserReport } from "../../../../packages/shared/src/browser";
import { REDACTED } from "../shared";
import { relativeTime } from "../lib/format";
import { openExternal } from "../lib/links";
import { createResource } from "../lib/resource";
import { Icon } from "../icons";
import { monospace, palette, radius, text, type Tone } from "../theme";
import { Badge, Banner, Button, CollapsibleRow, EmptyState, IconButton, ResourceState, Row, Small } from "../ui";
import { Card } from "../settings/accounts";
import { CodeView, filesHref, filesUnavailable, ImageView } from "./Files";
import { TabPage, type PanelTabProps } from "./parts";

// The session panel's Browser tab, as the web app's (session-browser.tsx): what the agent's browser tool saw, read from
// the reports and screenshots it leaves in the worktree's browser-output directory. It follows the newest call.

const missing = (error: string) => /no such file|not found/i.test(error);
function stampTime(stamp: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})$/.exec(stamp);
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z` : "";
}
const levelTone: Record<string, Tone> = { error: "danger", assert: "danger", warning: "warning", warn: "warning", info: "info" };

export function Browser(props: PanelTabProps) {
  return (
    <TabPage testID="panel-browser">
      <If when={props.session()} else={<Small>Loading…</Small>}>
        {current => (
          <If when={!filesUnavailable(current(), "see what its browser saw")}
            else={<EmptyState title="Browser unavailable">{current().status === "archived" ? "Archived sessions don't show their files. Unarchive the session to see what its browser saw."
              : "The browser's screenshots are files in the session's worktree: seeing them takes the session collaborator role, as the Files tab does. Viewers follow the conversation."}</EmptyState>}>
            <BrowserCalls {...props} />
          </If>
        )}
      </If>
    </TabPage>
  );
}

function BrowserCalls(props: PanelTabProps) {
  const listing = createResource<{ files: SessionFiles }>(() => filesHref(props.sessionId, BROWSER_OUTPUT));
  const files = () => listing.data()?.files;
  const stamps = computed(() => (files()?.type === "directory"
    ? (files() as Extract<SessionFiles, { type: "directory" }>).entries.flatMap(entry => {
      const match = entry.type === "file" ? BROWSER_REPORT_NAME.exec(entry.name) : null;
      return match ? [match[1]!] : [];
    }).sort().reverse() : []));
  const picked = signal<string | null>(null);
  const shown = () => (picked() && stamps().includes(picked()!) ? picked()! : stamps()[0]);
  const index = () => (shown() ? stamps().indexOf(shown()!) : -1);
  const older = () => (index() >= 0 && index() < stamps().length - 1 ? stamps()[index() + 1] : undefined);
  const newer = () => (index() > 0 ? stamps()[index() - 1] : undefined);
  // The agent's calls change the directory: read it again as the conversation moves on.
  let seen = "";
  effect(() => {
    const watched = `${props.session()?.activity ?? ""}|${props.view()?.entries.at(-1)?.id ?? ""}|${props.view()?.entries.length ?? 0}`;
    untracked(() => { if (seen && seen !== watched) listing.refresh(); seen = watched; });
  });
  return (
    <If when={!(listing.error() && missing(listing.error()))}
      else={<EmptyState title="No browser calls yet">When the agent opens a page with its browser tool, a headless Chromium in the session's sandbox, its screenshots and what it found show here. Ask it to look at a page, or at the app it works on.</EmptyState>}>
      <View style={{ gap: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <IconButton icon="chevron-left" label="Previous call" size={28} disabled={!older()} onPress={() => { if (older()) picked.set(older()!); }} />
          <IconButton icon="chevron-right" label="Next call" size={28} disabled={!newer()} onPress={() => { if (newer()) picked.set(index() === 1 ? null : newer()!); }} />
          <Small>{stamps().length ? `Call ${stamps().length - index()} of ${stamps().length}` : ""}</Small>
          <View style={{ flex: 1 }} />
          <If when={picked() && newer()}><Button small variant="outline" label="Latest" onPress={() => picked.set(null)} /></If>
          <IconButton icon="refresh" label="Refresh browser" size={28} disabled={listing.loading()} onPress={listing.refresh} />
        </View>
        <ResourceState inline loading={listing.loading() && !files()} error={listing.error()} retry={listing.refresh}>
          <If when={files()?.type === "directory"}>
            <If when={shown()} else={<EmptyState title="No browser calls yet">The browser-output directory holds no call's report.</EmptyState>}>
              {stamp => <Each of={[stamp()]} key={value => value}>{value => <BrowserCall sessionId={props.sessionId} stamp={value()} />}</Each>}
            </If>
          </If>
        </ResourceState>
      </View>
    </If>
  );
}

function BrowserCall(props: { sessionId: string; stamp: string }) {
  const file = createResource<{ files: SessionFiles }>(() => filesHref(props.sessionId, `${BROWSER_OUTPUT}/${props.stamp}.json`));
  const files = () => file.data()?.files;
  const report = () => {
    const current = files();
    return current?.type === "file" && current.text !== undefined ? parseBrowserReport(current.text) : undefined;
  };
  return (
    <ResourceState inline loading={file.loading() && !files()} error={file.error()} retry={file.refresh}>
      <If when={files()}>
        <If when={report()}
          else={<Banner tone="warning" title="Unreadable report">{`${BROWSER_OUTPUT}/${props.stamp}.json isn't a report the browser tool wrote: it may have been changed, or cut short.`}</Banner>}>
          {current => <ReportView sessionId={props.sessionId} report={current()} stamp={props.stamp}
            redacted={files()?.type === "file" && (files() as Extract<SessionFiles, { type: "file" }>).redacted === true} />}
        </If>
      </If>
    </ResourceState>
  );
}

function describeStep(report: BrowserReport, index: number): string {
  const step = report.request?.actions?.[index];
  const action = report.actions?.[index]?.action ?? step?.action ?? "";
  if (!step) return action;
  const target = step.url ?? step.selector ?? (step.x !== undefined && step.y !== undefined ? `${step.x}, ${step.y}` : undefined)
    ?? step.key ?? step.expression ?? (step.ms !== undefined ? `${step.ms} ms` : undefined);
  const typed = step.text !== undefined ? ` ${JSON.stringify(step.text.length > 60 ? `${step.text.slice(0, 60)}…` : step.text)}` : "";
  const value = step.value !== undefined ? ` = ${JSON.stringify(step.value)}` : "";
  return `${action}${target ? ` ${target.length > 120 ? `${target.slice(0, 120)}…` : target}` : ""}${typed}${value}`;
}

function ReportView(props: { sessionId: string; report: BrowserReport; stamp: string; redacted: boolean }) {
  const report = () => props.report;
  const url = () => report().url ?? report().request?.url ?? report().reopened ?? "";
  const linkable = () => /^https?:\/\//i.test(url()) && !/^https?:\/\/(localhost|127\.|\[::1\])/i.test(url());
  const time = () => report().time ?? stampTime(props.stamp);
  const failedActions = () => report().actions?.filter(item => !item.ok).length ?? 0;
  const shots = () => (report().actions ?? []).flatMap((item, index) => (item.screenshot ? [{ path: item.screenshot, label: `After step ${index + 1}` }] : []));
  const console = () => report().console ?? [];
  const consoleProblems = () => console().filter(entry => levelTone[entry.level] === "danger").length;
  const log = (badge: JSX.Element, line: string) => (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>{badge}<Text style={{ flex: 1, fontSize: text.small, color: palette().text }}>{line}</Text></View>
  );
  return (
    <View style={{ gap: 12 }}>
      {/* .browser-address: the page's address, like a browser's. */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, paddingHorizontal: 10, borderRadius: radius.medium, borderWidth: 1, borderColor: palette().border,
        backgroundColor: palette().surface }}>
        <Icon name={/^https:/i.test(url()) ? "lock" : "globe"} size={14} color={palette().muted} />
        <Text style={{ flex: 1, numberOfLines: 1, fontFamily: monospace, fontSize: text.small, color: palette().text }}>{url() || "about:blank"}</Text>
        <If when={linkable()}><IconButton icon="external-link" label="Open the page" size={24} onPress={() => openExternal(url())} /></If>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Text style={{ fontSize: text.small, color: report().title ? palette().text : palette().muted }}>{report().title || "Untitled"}</Text>
        <If when={report().status !== undefined}>
          <Badge tone={report().status! >= 400 ? "danger" : report().status! >= 300 ? "warning" : "success"}>{String(report().status)}</Badge>
        </If>
        <If when={report().error}><Badge tone="danger">Failed</Badge></If>
        <Small>{`${time() ? relativeTime(time()) : ""}${report().seconds !== undefined ? ` · ${report().seconds}s` : ""}`}</Small>
      </View>
      <If when={report().error}>
        <Banner tone="danger" title={failedActions() ? "An action failed" : "The page didn't open"}>
          {`${report().error}${report().skipped ? ` The ${report().skipped === 1 ? "next action was" : `next ${report().skipped} actions were`} skipped.` : ""}`}
        </Banner>
      </If>
      <If when={props.redacted}><Banner title="Secret hidden">{`Something that looks like a secret is shown as ${REDACTED}, as in the conversation.`}</Banner></If>
      <If when={report().screenshot} else={<EmptyState title="No screenshot">The call ended before the browser could take one.</EmptyState>}>
        {path => <Screenshot sessionId={props.sessionId} path={path()} />}
      </If>
      <Each of={shots()} key={shot => shot.path}>
        {shot => <CollapsibleRow plain title={shot().label} hint="Screenshot" leading={<Icon name="image" size={16} color={palette().muted} />}><Screenshot sessionId={props.sessionId} path={shot().path} /></CollapsibleRow>}
      </Each>
      <Card>
        <If when={report().actions?.length}>
          <CollapsibleRow title="Steps" open={failedActions() > 0} leading={<Icon name="terminal" size={16} color={palette().muted} />}
            hint={`${report().actions?.length}${failedActions() ? `, ${failedActions()} failed` : ""}${report().skipped ? `, ${report().skipped} skipped` : ""}`}>
            <Each of={report().actions ?? []} key="index">
              {(item, index) => (
                <View style={{ gap: 4 }}>
                  {log(<Badge tone={item().ok ? "success" : "danger"}>{item().ok ? "ok" : "failed"}</Badge>, describeStep(report(), index()))}
                  <If when={item().error}><Small tone="danger">{item().error}</Small></If>
                  <If when={item().note}><Small>{item().note}</Small></If>
                  <If when={item().value !== undefined}><CodeView text={String(item().value)} /></If>
                </View>
              )}
            </Each>
          </CollapsibleRow>
        </If>
        <If when={console().length}>
          <CollapsibleRow title="Console" open={consoleProblems() > 0} leading={<Icon name="message" size={16} color={palette().muted} />}
            hint={`${console().length}${consoleProblems() ? `, ${consoleProblems()} ${consoleProblems() === 1 ? "error" : "errors"}` : ""}`}>
            <Each of={console()} key="index">{entry => log(<Badge tone={levelTone[entry().level] ?? "neutral"}>{entry().level}</Badge>, entry().text)}</Each>
          </CollapsibleRow>
        </If>
        <If when={report().page_errors?.length}>
          <CollapsibleRow title="Page errors" open hint={String(report().page_errors?.length)} leading={<Icon name="alert" size={16} color={palette().muted} />}>
            <CodeView text={(report().page_errors ?? []).join("\n\n")} />
          </CollapsibleRow>
        </If>
        <If when={report().failed_requests?.length}>
          <CollapsibleRow title="Failed requests" hint={String(report().failed_requests?.length)} leading={<Icon name="alert" size={16} color={palette().muted} />}>
            <Each of={report().failed_requests ?? []} key="index">
              {entry => log(<Badge tone="danger">{String(entry().status ?? "failed")}</Badge>, `${entry().url}${entry().error ? ` (${entry().error})` : ""}`)}
            </Each>
          </CollapsibleRow>
        </If>
        <If when={report().text}>
          <CollapsibleRow title="Page text" hint={report().text_truncated ? "Its start" : undefined} leading={<Icon name="file" size={16} color={palette().muted} />}>
            <CodeView text={report().text ?? ""} />
          </CollapsibleRow>
        </If>
        <If when={report().elements?.length}>
          <CollapsibleRow title="Elements" hint={`${report().elements?.length} the agent can act on`} leading={<Icon name="tool" size={16} color={palette().muted} />}>
            <Each of={report().elements ?? []} key="index">
              {element => <Small>{`${element().selector}  ${element().tag}${element().type ? `[${element().type}]` : ""}${element().disabled ? " disabled" : ""}${element().text ? `  ${element().text}` : ""}`}</Small>}
            </Each>
          </CollapsibleRow>
        </If>
        <If when={report().serve_output}>
          <CollapsibleRow title="Server output" leading={<Icon name="server" size={16} color={palette().muted} />}
            hint={report().request?.serve ? [report().request!.serve!.program, ...(report().request!.serve!.args ?? [])].join(" ") : undefined}>
            <CodeView text={report().serve_output ?? ""} />
          </CollapsibleRow>
        </If>
        <Row title="Report" hint={`${BROWSER_OUTPUT}/${props.stamp}.json`} />
      </Card>
    </View>
  );
}

function Screenshot(props: { sessionId: string; path: string }) {
  const valid = () => BROWSER_SCREENSHOT_PATH.test(props.path);
  const image = createResource<{ files: SessionFiles }>(() => (valid() ? filesHref(props.sessionId, props.path) : null));
  const files = () => image.data()?.files;
  const shot = () => (files()?.type === "file" ? (files() as Extract<SessionFiles, { type: "file" }>).image : undefined);
  return (
    <If when={valid()}>
      <ResourceState inline loading={image.loading() && !files()} error={image.error()} retry={image.refresh}>
        <If when={files()?.type === "file"}>
          <If when={shot()} else={<EmptyState title="No preview">{`${props.path} is too large to show here, or isn't an image.`}</EmptyState>}>
            {current => <ImageView src={`data:${current().mimeType};base64,${current().data}`} path={props.path} />}
          </If>
        </If>
      </ResourceState>
    </If>
  );
}

import type { JSX } from "nsh";
