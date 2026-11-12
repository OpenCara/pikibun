import type { EntryView, SessionView } from "../../../packages/shared/src/types.js";
import { redactEntry } from "../../../packages/shared/src/redaction.js";
import { briefEntry, entriesBefore, latestEntries } from "../../../packages/shared/src/transcript-display.js";
import { ViewRevisions } from "../../../packages/shared/src/view-patch.js";
import type { LocalPage, LocalView } from "./app-host-protocol.js";

export class LocalViews {
  readonly #revisions = new WeakMap<object, { brief: boolean; revisions: ViewRevisions }>();
  readonly #redacted = new WeakMap<object, EntryView>();
  readonly #briefed = new WeakMap<object, EntryView>();

  view(session: object, raw: SessionView, { since, brief = false }: { since?: string; brief?: boolean }): LocalView {
    let feed = this.#revisions.get(session);
    if (!feed || feed.brief !== brief) this.#revisions.set(session, feed = { brief, revisions: new ViewRevisions(8) });
    const current = feed.revisions.record(latestEntries(this.shown(raw, brief)));
    const patch = since === undefined ? null : feed.revisions.since(since, current);
    return patch ? { patch } : { view: current.view, revision: current.revision };
  }

  entries(raw: SessionView, { conversation, before, limit, brief = false }: { conversation: string; before: string; limit: number; brief?: boolean }): LocalPage | null {
    return entriesBefore(this.shown(raw, brief), conversation, before, limit);
  }

  private shown(raw: SessionView, brief: boolean): SessionView {
    const { olderApprovals: _older, approvals: _approvals, ...rest } = raw;
    const entries = raw.entries.map(entry => this.redacted(entry));
    return { ...rest, entries: brief ? entries.map(entry => this.brief(entry)) : entries, approvals: [] };
  }

  private redacted(entry: EntryView): EntryView {
    if (!entry || typeof entry !== "object") return redactEntry(entry);
    let shown = this.#redacted.get(entry);
    if (!shown) this.#redacted.set(entry, shown = redactEntry(entry));
    return shown;
  }

  private brief(entry: EntryView): EntryView {
    if (!entry || typeof entry !== "object") return entry;
    let shown = this.#briefed.get(entry);
    if (!shown) this.#briefed.set(entry, shown = briefEntry(entry));
    return shown;
  }
}
