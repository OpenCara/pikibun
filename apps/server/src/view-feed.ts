import { HTTPException } from 'hono/http-exception';
import type { EntryView, SessionView } from '../../../packages/shared/src/types.js';
import { redactApproval, redactEntry } from '../../../packages/shared/src/redaction.js';
import {
  applyViewPatch, isPatchableView, isRevision, isViewPatch, reuseUnchanged, ViewRevisions, type SessionViewPatch,
} from '../../../packages/shared/src/view-patch.js';
import { onSessionChange, requireRunnerAccess } from './authority/index.js';
import type { ConnectionPin } from './connector-transport.js';
import { fail } from './http.js';
import { runnerJSON, runnerRequest } from './runner.js';
import { briefEntry, entriesBefore, fullTranscript, latestEntries, type TranscriptDisplay } from '../../../packages/shared/src/transcript-display.js';
import type { AppContext, SessionRow } from './types.js';

const freshMs = 900;
const idleMs = 60_000;
const maxFeeds = 256;

export interface ShownView {
  revision: string;
  view: SessionView;
}

interface Snapshot {
  hostRevision?: string;
  generation: string | null;
  raw: SessionView;
  full: SessionView;
  shown: ShownView;
}

interface Feed {
  key: string;
  display: TranscriptDisplay;
  snapshot?: Snapshot;
  fresh: boolean;
  epoch: number;
  started: number;
  applied: number;
  inflight?: { epoch: number; promise: Promise<Snapshot> };
  revisions: ViewRevisions;
  usedAt: number;
}

const registries = new WeakMap<object, Map<string, Feed>>();
const redacted = new WeakMap<object, EntryView>();
const briefed = new WeakMap<object, EntryView>();

function registry(env: object): Map<string, Feed> {
  let feeds = registries.get(env);
  if (!feeds) registries.set(env, feeds = new Map());
  return feeds;
}

export async function transcriptDisplay(c: AppContext, row: SessionRow): Promise<TranscriptDisplay> {
  const current = await c.env.DB.query<{ tool_output: string | null; paging: number | null }>(`SELECT s.tool_output, t.paging
    FROM sessions s LEFT JOIN workspace_transcript_settings t ON t.workspace_id = s.workspace_id WHERE s.id = ?`).bind(row.id).first();
  return { toolOutput: (current ? current.tool_output : row.tool_output) === 'brief' ? 'brief' : 'full', paging: current?.paging === 1 };
}

function feedFor(c: AppContext, row: SessionRow, display: TranscriptDisplay): Feed {
  const feeds = registry(c.env);
  const now = Date.now();
  for (const [id, feed] of feeds) if (now - feed.usedAt > idleMs && !feed.inflight) feeds.delete(id);
  const key = JSON.stringify([row.owner_id, row.connector_id ?? null, display.toolOutput, display.paging]);
  let feed = feeds.get(row.id);
  if (!feed || feed.key !== key) {
    feed = { key, display: { ...display }, fresh: false, epoch: 0, started: 0, applied: 0, revisions: new ViewRevisions(8), usedAt: now };
  }
  feeds.delete(row.id);
  feeds.set(row.id, feed);
  feed.usedAt = now;
  for (const id of feeds.keys()) {
    if (feeds.size <= maxFeeds) break;
    feeds.delete(id);
  }
  return feed;
}

export function invalidateSessionView(c: AppContext, sessionId: string): void {
  const feed = registry(c.env).get(sessionId);
  if (!feed) return;
  feed.epoch++;
  feed.fresh = false;
}
onSessionChange(invalidateSessionView);

export async function sessionView(c: AppContext, row: SessionRow, { latest = false, display = fullTranscript }: { latest?: boolean; display?: TranscriptDisplay } = {}): Promise<ShownView> {
  return (await currentSnapshot(c, row, feedFor(c, row, display), latest)).shown;
}

async function currentSnapshot(c: AppContext, row: SessionRow, feed: Feed, latest: boolean): Promise<Snapshot> {
  if (latest) return refresh(c, row, feed);
  if (feed.fresh && feed.snapshot) {
    await requireRunnerAccess(c, c.get('auth').userId, row, 'view');
    return feed.snapshot;
  }
  const inflight = feed.inflight;
  if (inflight && inflight.epoch === feed.epoch) {
    await requireRunnerAccess(c, c.get('auth').userId, row, 'view');
    try { return await inflight.promise; } catch (error) {
      if (!(error instanceof HTTPException) || error.status !== 403) throw error;
    }
  }
  return refresh(c, row, feed);
}

export async function earlierEntries(c: AppContext, row: SessionRow, display: TranscriptDisplay, conversationId: string, before: string,
  limit: number): Promise<{ entries: EntryView[]; older: number } | null> {
  const feed = feedFor(c, row, display);
  const page = entriesBefore((await currentSnapshot(c, row, feed, false)).full, conversationId, before, limit);
  return page ?? entriesBefore((await currentSnapshot(c, row, feed, true)).full, conversationId, before, limit);
}

export function viewChanges(c: AppContext, row: SessionRow, since: string | undefined, current: ShownView,
  display: TranscriptDisplay = fullTranscript): SessionViewPatch | null {
  return feedFor(c, row, display).revisions.since(since, current);
}

function refresh(c: AppContext, row: SessionRow, feed: Feed): Promise<Snapshot> {
  const sequence = ++feed.started;
  const epoch = feed.epoch;
  const promise = fetchSnapshot(c, row, feed.snapshot, feed.display).then(({ view, ...fetched }) => {
    if (sequence < feed.applied) return feed.snapshot!;
    feed.applied = sequence;
    const shown = feed.revisions.record(feed.display.paging ? latestEntries(view) : view);
    const snapshot: Snapshot = { ...fetched, full: view, shown };
    feed.snapshot = snapshot;
    if (epoch === feed.epoch) {
      feed.fresh = true;
      const timer = setTimeout(() => { if (feed.snapshot === snapshot) feed.fresh = false; }, freshMs);
      timer.unref?.();
    }
    return snapshot;
  }).finally(() => { if (feed.inflight?.promise === promise) feed.inflight = undefined; });
  feed.inflight = { epoch, promise };
  return promise;
}

async function fetchSnapshot(c: AppContext, row: SessionRow, base: Snapshot | undefined,
  display: TranscriptDisplay): Promise<Omit<Snapshot, 'shown' | 'full'> & { view: SessionView }> {
  const read = async (since?: string): Promise<Omit<Snapshot, 'shown' | 'full'> | null> => {
    const pin: ConnectionPin = since && row.connector_id ? { hash: base!.generation } : {};
    let reply: { view?: SessionView; revision?: unknown; patch?: unknown };
    try {
      reply = await runnerJSON(await runnerRequest(c, row, 'view', since ?? '', undefined, pin));
    } catch (error) {
      if (since && (pin.replaced || (error instanceof HTTPException && [400, 404, 405, 502].includes(error.status)))) return null;
      throw error;
    }
    const generation = row.connector_id ? pin.hash ?? null : null;
    try {
      if (reply.patch !== undefined) {
        if (!since || !isViewPatch(reply.patch) || reply.patch.base !== since) throw new Error('Unexpected view patch');
        return { raw: applyViewPatch(base!.raw, reply.patch), hostRevision: reply.patch.revision, generation };
      }
      if (!isPatchableView(reply.view)) throw new Error('Invalid view');
      const raw = base ? reuseUnchanged(base.raw, reply.view) : reply.view;
      return { raw, hostRevision: isRevision(reply.revision) ? reply.revision : undefined, generation };
    } catch {
      if (since) return null;
      fail(502, 'invalid_runner_response', 'The runner returned an invalid view.');
    }
  };
  const since = base?.hostRevision && (!row.connector_id || base.generation) ? base.hostRevision : undefined;
  const result = (since ? await read(since) : null) ?? await read();
  if (!result) fail(502, 'invalid_runner_response', 'The runner returned an invalid view.');
  const { raw } = result;
  if (raw.sessionId !== row.id || raw.owner?.id !== row.owner_id) fail(502, 'invalid_runner_response', 'The runner returned an inconsistent session binding.');
  const { olderApprovals: _older, approvals: _approvals, ...rest } = raw;
  const entries = raw.entries.map(redactedEntry);
  const view: SessionView = { ...rest, entries: display.toolOutput === 'brief' ? entries.map(briefedEntry) : entries, approvals: [] };
  return { ...result, view };
}

function briefedEntry(entry: EntryView): EntryView {
  if (!entry || typeof entry !== 'object') return entry;
  let shown = briefed.get(entry);
  if (!shown) briefed.set(entry, shown = briefEntry(entry));
  return shown;
}

function redactedEntry(entry: EntryView): EntryView {
  if (!entry || typeof entry !== 'object') return redactEntry(entry);
  let shown = redacted.get(entry);
  if (!shown) redacted.set(entry, shown = redactEntry(entry));
  return shown;
}
