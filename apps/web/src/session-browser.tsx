import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionFiles, SessionRecord } from "../../../packages/shared/src/types";
import { BROWSER_OUTPUT, BROWSER_REPORT_NAME, BROWSER_SCREENSHOT_PATH, parseBrowserReport, type BrowserReport } from "../../../packages/shared/src/browser";
import { REDACTED } from "../../../packages/shared/src/redaction";
import { segment } from "./api";
import { Icon } from "./icons";
import { ImageView } from "./session-files";
import { Alert, Button, Collapsible, EmptyState, Loading, RelativeTime, ResourceState, Row, StatusBadge, useResource, type Tone } from "./ui";

/*
 * The session panel's Browser tab: what the agent's browser tool (piki:browser) saw. Each call leaves a report and
 * screenshots in the worktree's browser-output directory, which this reads through the file browser's API, so it shows
 * what is on the host now, takes the same collaborator role as the Files tab, and needs nothing of the host but what
 * the Files tab does. It follows the newest call as the agent works, until an older one is picked.
 */

function filesHref(session: SessionRecord, path: string): string {
  return `/api/sessions/${segment(session.id)}/files?path=${encodeURIComponent(path)}`;
}

/** The directory isn't there: the agent hasn't used the browser in this session (or its files were removed). */
const missing = (error: string) => /no such file|not found/i.test(error);

/** "2026-11-04T20:11:52Z" from a report's name, "20261104-201152-305.json", for a call whose report says no time. */
function stampTime(stamp: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})$/.exec(stamp);
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z` : "";
}

const levelTone: Record<string, Tone> = { error: "danger", assert: "danger", warning: "warning", warn: "warning", info: "info" };

/**
 * `changes`: what tells the tab to look again, such as the session's newest transcript entry: each browser call ends in
 * one, whether or not it had a card.
 */
export function BrowserPanel({ session, changes }: { session: SessionRecord; changes: string }) {
  const permissions = session.permissions ?? [];
  if (session.status === "archived") return <EmptyState title="Browser unavailable">Archived sessions don't show their files. Unarchive the session to see what its browser saw.</EmptyState>;
  if (!permissions.includes("write")) {
    return <EmptyState title="Browser unavailable">The browser's screenshots are files in the session's worktree: seeing them takes the session collaborator role, as the Files tab does. Viewers follow the conversation.</EmptyState>;
  }
  return <BrowserCalls key={session.id} session={session} changes={changes} />;
}

function BrowserCalls({ session, changes }: { session: SessionRecord; changes: string }) {
  const listing = useResource<{ files: SessionFiles }>(filesHref(session, BROWSER_OUTPUT));
  const files = listing.data?.files;
  // Newest first: a report's name is its call's time.
  const stamps = useMemo(() => files?.type === "directory"
    ? files.entries.flatMap(entry => { const match = entry.type === "file" ? BROWSER_REPORT_NAME.exec(entry.name) : null; return match ? [match[1]!] : []; }).sort().reverse()
    : [], [files]);
  // null follows the newest call; a stamp holds that call while the agent goes on.
  const [picked, setPicked] = useState<string | null>(null);
  const shown = picked && stamps.includes(picked) ? picked : stamps[0];
  const index = shown ? stamps.indexOf(shown) : -1;
  // The agent's calls change the directory: read it again as the conversation moves on, or what the session does changes.
  const watched = `${session.activity ?? ""}|${changes}`;
  const seen = useRef(watched);
  const { refresh } = listing;
  useEffect(() => {
    if (seen.current === watched) return;
    seen.current = watched;
    refresh();
  }, [watched, refresh]);

  if (listing.error && missing(listing.error)) {
    return <EmptyState title="No browser calls yet">When the agent opens a page with its browser tool, a headless Chromium in the session's sandbox, its screenshots and what it found show here. Ask it to look at a page, or at the app it works on.</EmptyState>;
  }
  const older = index >= 0 && index < stamps.length - 1 ? stamps[index + 1] : undefined;
  const newer = index > 0 ? stamps[index - 1] : undefined;
  return <div className="browser-panel">
    <div className="file-browser-bar">
      <Button variant="ghost" size="xs" icon="chevron-left" aria-label="Previous call" title="Previous call" disabled={!older} onClick={() => older && setPicked(older)} />
      <Button variant="ghost" size="xs" icon="chevron-right" aria-label="Next call" title="Next call" disabled={!newer} onClick={() => newer && setPicked(index === 1 ? null : newer)} />
      <span className="muted small browser-position">{stamps.length ? `Call ${stamps.length - index} of ${stamps.length}` : ""}</span>
      <span className="spacer" />
      {picked && newer && <Button variant="outline" size="xs" onClick={() => setPicked(null)}>Latest</Button>}
      <Button variant="ghost" size="xs" icon="refresh" aria-label="Refresh browser" title="Refresh" disabled={listing.loading} onClick={listing.refresh} />
    </div>
    <ResourceState loading={listing.loading && !files} error={listing.error} retry={listing.refresh}>
      {files?.type === "directory" && (shown
        ? <BrowserCall key={shown} session={session} stamp={shown} />
        : <EmptyState title="No browser calls yet">The browser-output directory holds no call's report.</EmptyState>)}
    </ResourceState>
  </div>;
}

function BrowserCall({ session, stamp }: { session: SessionRecord; stamp: string }) {
  const file = useResource<{ files: SessionFiles }>(filesHref(session, `${BROWSER_OUTPUT}/${stamp}.json`));
  const files = file.data?.files;
  const report = files?.type === "file" && files.text !== undefined ? parseBrowserReport(files.text) : undefined;
  return <ResourceState loading={file.loading && !files} error={file.error} retry={file.refresh}>
    {files && (report ? <BrowserReportView session={session} report={report} stamp={stamp} redacted={files.type === "file" && files.redacted === true} />
      : <Alert variant="warning" title="Unreadable report">{`${BROWSER_OUTPUT}/${stamp}.json`} isn't a report the browser tool wrote: it may have been changed, or cut short.</Alert>)}
  </ResourceState>;
}

function BrowserReportView({ session, report, stamp, redacted }: { session: SessionRecord; report: BrowserReport; stamp: string; redacted: boolean }) {
  const url = report.url ?? report.request?.url ?? report.reopened ?? "";
  const linkable = /^https?:\/\//i.test(url) && !/^https?:\/\/(localhost|127\.|\[::1\])/i.test(url);
  const time = report.time ?? stampTime(stamp);
  const failedActions = report.actions?.filter(item => !item.ok).length ?? 0;
  const shots = (report.actions ?? []).flatMap((item, index) => item.screenshot ? [{ path: item.screenshot, label: `After step ${index + 1}` }] : []);
  const console = report.console ?? [];
  const consoleProblems = console.filter(entry => levelTone[entry.level] === "danger").length;
  return <div className="stack">
    <div className="browser-address" title={url}>
      <Icon name={/^https:/i.test(url) ? "lock" : "globe"} size={14} />
      <span className="browser-url">{url || "about:blank"}</span>
      {linkable && <a className="browser-open" href={url} target="_blank" rel="noreferrer noopener" aria-label="Open the page in a new tab" title="Open in a new tab"><Icon name="external" size={14} /></a>}
    </div>
    <div className="browser-meta small">
      <span className="browser-title">{report.title || <span className="muted">Untitled</span>}</span>
      {report.status !== undefined && <StatusBadge tone={report.status >= 400 ? "danger" : report.status >= 300 ? "warning" : "success"}>{report.status}</StatusBadge>}
      {report.error ? <StatusBadge tone="danger">Failed</StatusBadge> : null}
      <span className="muted">{time && <RelativeTime value={time} />}{report.seconds !== undefined ? ` · ${report.seconds}s` : ""}</span>
    </div>
    {report.error && <Alert variant="error" title={failedActions ? "An action failed" : "The page didn't open"}>
      {report.error}{report.skipped ? ` The ${report.skipped === 1 ? "next action was" : `next ${report.skipped} actions were`} skipped.` : ""}
    </Alert>}
    {redacted && <Alert title="Secret hidden">Something that looks like a secret is shown as <code>{REDACTED}</code>, as in the conversation.</Alert>}
    {report.screenshot ? <Screenshot session={session} path={report.screenshot} /> : <EmptyState title="No screenshot">The call ended before the browser could take one.</EmptyState>}
    {shots.map(shot => <Collapsible key={shot.path} title={shot.label} hint="Screenshot" leading={<Icon name="image" size={16} />}>
      <Screenshot session={session} path={shot.path} />
    </Collapsible>)}
    <div className="card">
      {report.actions && report.actions.length > 0 && <Collapsible title="Steps" hint={`${report.actions.length}${failedActions ? `, ${failedActions} failed` : ""}${report.skipped ? `, ${report.skipped} skipped` : ""}`} leading={<Icon name="terminal" size={16} />} open={failedActions > 0}>
        <ol className="browser-steps small">
          {report.actions.map((item, index) => <li key={index}>
            <StatusBadge tone={item.ok ? "success" : "danger"}>{item.ok ? "ok" : "failed"}</StatusBadge> <code>{describeStep(report, index)}</code>
            {item.error && <div className="browser-step-detail">{item.error}</div>}
            {item.note && <div className="browser-step-detail muted">{item.note}</div>}
            {item.value !== undefined && <pre className="browser-value">{item.value}</pre>}
          </li>)}
        </ol>
      </Collapsible>}
      {console.length > 0 && <Collapsible title="Console" hint={`${console.length}${consoleProblems ? `, ${consoleProblems} ${consoleProblems === 1 ? "error" : "errors"}` : ""}`} leading={<Icon name="message" size={16} />} open={consoleProblems > 0}>
        <ul className="browser-log small">{console.map((entry, index) => <li key={index}><StatusBadge tone={levelTone[entry.level] ?? "neutral"}>{entry.level}</StatusBadge> <span className="browser-log-text">{entry.text}</span></li>)}</ul>
      </Collapsible>}
      {(report.page_errors?.length ?? 0) > 0 && <Collapsible title="Page errors" hint={String(report.page_errors!.length)} leading={<Icon name="alert" size={16} />} open>
        <pre className="browser-value">{report.page_errors!.join("\n\n")}</pre>
      </Collapsible>}
      {(report.failed_requests?.length ?? 0) > 0 && <Collapsible title="Failed requests" hint={String(report.failed_requests!.length)} leading={<Icon name="alert" size={16} />}>
        <ul className="browser-log small">{report.failed_requests!.map((entry, index) => <li key={index}>
          <StatusBadge tone="danger">{entry.status ?? "failed"}</StatusBadge> <span className="browser-log-text">{entry.url}{entry.error ? ` (${entry.error})` : ""}</span>
        </li>)}</ul>
      </Collapsible>}
      {report.text && <Collapsible title="Page text" hint={report.text_truncated ? "Its start" : undefined} leading={<Icon name="file" size={16} />}>
        <pre className="browser-value">{report.text}</pre>
      </Collapsible>}
      {(report.elements?.length ?? 0) > 0 && <Collapsible title="Elements" hint={`${report.elements!.length} the agent can act on`} leading={<Icon name="tool" size={16} />}>
        <ul className="browser-log small">{report.elements!.map((element, index) => <li key={index}>
          <code>{element.selector}</code> <span className="muted">{element.tag}{element.type ? `[${element.type}]` : ""}{element.disabled ? " disabled" : ""}</span>
          {element.text && <span className="browser-log-text"> {element.text}</span>}
        </li>)}</ul>
      </Collapsible>}
      {report.serve_output && <Collapsible title="Server output" hint={report.request?.serve?.command} leading={<Icon name="server" size={16} />}>
        <pre className="browser-value">{report.serve_output}</pre>
      </Collapsible>}
      <Row title="Report" hint={<code>{`${BROWSER_OUTPUT}/${stamp}.json`}</code>} />
    </div>
  </div>;
}

/** One step of the call as the agent asked for it: its action and what it acted on. */
function describeStep(report: BrowserReport, index: number): string {
  const step = report.request?.actions?.[index];
  const action = report.actions?.[index]?.action ?? step?.action ?? "";
  if (!step) return action;
  const target = step.url ?? step.selector ?? (step.x !== undefined && step.y !== undefined ? `${step.x}, ${step.y}` : undefined)
    ?? step.key ?? step.expression ?? (step.ms !== undefined ? `${step.ms} ms` : undefined);
  const text = step.text !== undefined ? ` ${JSON.stringify(step.text.length > 60 ? `${step.text.slice(0, 60)}…` : step.text)}` : "";
  const value = step.value !== undefined ? ` = ${JSON.stringify(step.value)}` : "";
  return `${action}${target ? ` ${target.length > 120 ? `${target.slice(0, 120)}…` : target}` : ""}${text}${value}`;
}

function Screenshot({ session, path }: { session: SessionRecord; path: string }) {
  const valid = BROWSER_SCREENSHOT_PATH.test(path);
  const image = useResource<{ files: SessionFiles }>(valid ? filesHref(session, path) : null);
  const files = image.data?.files;
  if (!valid) return null;
  return <ResourceState loading={image.loading && !files} error={image.error} retry={image.refresh}>
    {files?.type === "file" && (files.image
      ? <ImageView key={path} src={`data:${files.image.mimeType};base64,${files.image.data}`} path={path} />
      : <EmptyState title="No preview">{path} is too large to show here, or isn't an image.</EmptyState>)}
    {image.loading && !files && <Loading>Loading screenshot</Loading>}
  </ResourceState>;
}
