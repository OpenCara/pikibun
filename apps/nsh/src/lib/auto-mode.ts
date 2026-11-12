import { segment, type AutoChoiceAnswer, type AutoChoiceRequest } from "../shared";
import { session } from "./auth";
import { createResource } from "./resource";

export const AUTO = "\u0000auto";

export function createAutoMode(workspaceId: () => string | null) {
  const path = () => { const id = workspaceId(); return id ? `/api/workspaces/${segment(id)}/auto-mode` : null; };
  const status = createResource<{ enabled: boolean }>(path);
  return {
    enabled: () => status.data()?.enabled === true,
    async choose(request: AutoChoiceRequest, signal?: AbortSignal): Promise<AutoChoiceAnswer> {
      const target = path();
      if (!target) throw new Error("Choose a workspace first.");
      const { choice } = await session().api<{ choice: AutoChoiceAnswer }>(target, { method: "POST", body: request, ...(signal ? { signal } : {}) });
      return choice;
    },
  };
}

export type AutoMode = ReturnType<typeof createAutoMode>;
