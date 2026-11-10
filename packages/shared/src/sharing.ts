import type { EntryView, SessionRecord } from "./types.js";

export interface SessionLink {
  url: string;
  createdAt: string;
}

export interface SharedSession {
  title: string;
  status: SessionRecord["status"];
  createdAt: string;
  ownerName: string;
}

export interface SharedSessionView {
  entries: EntryView[];
  busy: boolean;
}

declare module "./types.js" {
  interface SessionRecord {
    linkShared?: boolean;
  }
}
