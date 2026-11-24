import type { BrokeredToolDefinition } from "./tool-definitions.js";

export const workspaceMemoryLimits = Object.freeze({
  instructionsChars: 16_000,
  memoryChars: 32_000,
  noteChars: 2_000,
  pendingNotes: 200,
  listedNotes: 50,
  resolvedAtOnce: 50,
});

export const memoryNoteStatuses = ["pending", "accepted", "dismissed"] as const;
export type MemoryNoteStatus = (typeof memoryNoteStatuses)[number];
export const memoryNoteResolutions = ["accepted", "dismissed"] as const;
export type MemoryNoteResolution = (typeof memoryNoteResolutions)[number];

export interface WorkspaceMemory {
  instructions: string;
  memory: string;
  revision: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface WorkspaceMemoryNote {
  id: string;
  sessionId: string | null;
  sessionTitle?: string;
  authorId: string;
  text: string;
  status: MemoryNoteStatus;
  createdAt: string;
  resolvedBy?: string;
  resolvedAt?: string;
}

export interface WorkspaceMemoryView {
  memory: WorkspaceMemory;
  notes: WorkspaceMemoryNote[];
  pendingNotes: number;
  enabled: boolean;
  admin: boolean;
}

export interface WorkspaceMemoryPrompt {
  instructions: string;
  memory: string;
  revision: number;
  pendingNotes: number;
}

export const memoryReadActions = ["read", "notes"] as const;
export const memoryWriteActions = ["note", "update", "resolve"] as const;
export const memoryToolActions = [...memoryReadActions, ...memoryWriteActions] as const;
export type MemoryToolAction = (typeof memoryToolActions)[number];

export function isMemoryWriteAction(action: string): boolean {
  return (memoryWriteActions as readonly string[]).includes(action);
}

export const memoryActionFields: Readonly<Record<MemoryToolAction, { required: readonly string[]; optional?: readonly string[] }>> = {
  read: { required: [] },
  notes: { required: [] },
  note: { required: ["text"] },
  update: { required: ["revision"], optional: ["memory", "instructions", "accept"] },
  resolve: { required: ["notes", "status"] },
};

const noteIds = "^[A-Za-z0-9_-]{1,64}(?:,[A-Za-z0-9_-]{1,64}){0,49}$";

export const memoryToolDescription = "Read and add to this workspace's memory: what its sessions should know about its projects, kept by Pikibun across sessions, "
  + "as Claude Projects keep a project's knowledge. It acts as the person whose message you are working on. "
  + "read: the workspace's instructions and memory, its revision, and how many notes wait. "
  + "note {text}: propose a note for the memory (a decision, a convention, a lesson, where something lives, what a finished sub-task found), "
  + `at most ${workspaceMemoryLimits.noteChars} characters, self-contained, without secrets; the workspace's owners and admins accept or dismiss it. `
  + "notes: the notes waiting, with their ids. "
  + "update {revision, memory?, instructions?, accept?} (owners and admins): replace the memory or the instructions with new text, as of revision (the one read returned; "
  + "a newer one refuses, so read again and merge), and with accept, note ids separated by commas, mark the notes it took in as accepted. "
  + "resolve {notes, status} (owners and admins): mark notes (ids separated by commas) accepted or dismissed without changing the memory. "
  + "Nothing here changes in a Read-only message.";

export const memoryToolDefinition: BrokeredToolDefinition = {
  kind: "brokered", name: "memory", extensions: ["piki:memory"],
  description: memoryToolDescription,
  parameters: {
    action: { type: "string", required: true, enum: [...memoryToolActions], invalid: `action is one of ${memoryToolActions.join(", ")}` },
    text: { type: "string", maxLength: workspaceMemoryLimits.noteChars, description: "The note: one self-contained fact, decision or lesson.",
      invalid: `text is a note of at most ${workspaceMemoryLimits.noteChars} characters` },
    memory: { type: "string", maxLength: workspaceMemoryLimits.memoryChars, description: "The workspace's whole new memory, in Markdown.",
      invalid: `memory is at most ${workspaceMemoryLimits.memoryChars} characters` },
    instructions: { type: "string", maxLength: workspaceMemoryLimits.instructionsChars, description: "The workspace's whole new instructions, in Markdown.",
      invalid: `instructions is at most ${workspaceMemoryLimits.instructionsChars} characters` },
    revision: { type: "integer", minimum: 0, description: "The revision read returned, which the update replaces.", invalid: "revision is the revision read returned" },
    accept: { type: "string", pattern: noteIds, description: "Note ids separated by commas, which this update took in.", invalid: "accept is note ids separated by commas, as notes lists them" },
    notes: { type: "string", pattern: noteIds, description: "Note ids separated by commas, as notes lists them.", invalid: "notes is note ids separated by commas, as notes lists them" },
    status: { type: "string", enum: [...memoryNoteResolutions], description: "accepted or dismissed.", invalid: `status is one of ${memoryNoteResolutions.join(", ")}` },
  },
  target: ["action", "notes", "status"],
  route: "memory", write: false,
  instructions: "This workspace keeps a memory across its sessions, with the memory tool. Its current text is in your instructions under Workspace memory; "
    + "where it isn't, read it with memory {action: \"read\"} before you start a task. "
    + "When you learn something later sessions should know (a decision, a convention, a pitfall, where something lives), and when you finish a task, "
    + "above all one another session gave you, propose it with memory {action: \"note\", text}: a short, self-contained note, never a secret. "
    + "Don't note what the repositories' own files already say.",
};

export function parseWorkspaceMemoryPrompt(value: unknown): WorkspaceMemoryPrompt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { instructions, memory, revision, pendingNotes } = value as Record<string, unknown>;
  const text = (item: unknown, limit: number) => typeof item === "string" && item.length <= limit && !item.includes("\0");
  if (!text(instructions, workspaceMemoryLimits.instructionsChars) || !text(memory, workspaceMemoryLimits.memoryChars)) return undefined;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0 || !Number.isSafeInteger(pendingNotes) || (pendingNotes as number) < 0) return undefined;
  return { instructions: instructions as string, memory: memory as string, revision: revision as number, pendingNotes: pendingNotes as number };
}

export function workspaceMemoryPrompt(prompt: WorkspaceMemoryPrompt, options: { tool: boolean; sessions: boolean }): string {
  const parts: string[] = [];
  const instructions = prompt.instructions.trim();
  const memory = prompt.memory.trim();
  if (instructions) parts.push(`Workspace instructions, which this workspace's owners and admins wrote for every session here:\n${instructions}`);
  if (memory) parts.push(`Workspace memory (revision ${prompt.revision}), what earlier sessions here learned and this workspace's owners and admins kept. `
    + `It may be out of date: where it disagrees with the files, trust the files and say so.\n${memory}`);
  else if (options.tool) parts.push("Workspace memory: this workspace's memory is empty so far.");
  if (options.tool && prompt.pendingNotes > 0) parts.push(`${prompt.pendingNotes} proposed note${prompt.pendingNotes === 1 ? "" : "s"} wait for this workspace's owners and admins `
    + "(memory {action: \"notes\"}); they are not part of the memory yet.");
  if (options.sessions && (instructions || memory || options.tool)) parts.push("This workspace's earlier sessions are its history: to find what one of them did or decided, "
    + "search them with sessions {action: \"search\", query} and read the one that matches, rather than asking the person again.");
  return parts.join("\n\n");
}
