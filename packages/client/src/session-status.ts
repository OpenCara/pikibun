import type { SessionActivity, SessionRecord } from "../../shared/src/types";

export type SessionStatusTone = "running" | "warning" | "danger" | "success" | "neutral" | "info";

export interface SessionStatus {
  tone: SessionStatusTone;
  label?: string;
  icon?: "clock";
}

const activityStatus: Record<SessionActivity, Required<Omit<SessionStatus, "icon">>> = {
  working: { tone: "running", label: "In progress" },
  waiting: { tone: "warning", label: "Needs approval" },
  failed: { tone: "danger", label: "Failed" },
  done: { tone: "success", label: "Done" },
  idle: { tone: "neutral", label: "Idle" },
};

export function sessionStatus(session: Pick<SessionRecord, "status" | "activity" | "nextScheduledAt">, activity = session.activity): SessionStatus {
  if (session.status === "archived") return { tone: "neutral", label: "Archived" };
  if (session.status === "provisioning") return { tone: "running", label: "Starting" };
  if (session.status === "error") return { tone: "danger", label: "Not started" };
  if (session.nextScheduledAt && activity !== "working" && activity !== "waiting" && activity !== "failed") {
    return { tone: "info", label: "Scheduled", icon: "clock" };
  }
  return activity && Object.hasOwn(activityStatus, activity) ? activityStatus[activity] : { tone: "success" };
}
