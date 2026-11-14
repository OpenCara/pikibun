import { segment } from "../shared";
import { createResource } from "./resource";

export const AUTO = "\u0000auto";

export function createAutoMode(workspaceId: () => string | null) {
  const path = () => { const id = workspaceId(); return id ? `/api/workspaces/${segment(id)}/auto-mode` : null; };
  const status = createResource<{ enabled: boolean }>(path);
  return {
    enabled: () => status.data()?.enabled === true,
  };
}

export type AutoMode = ReturnType<typeof createAutoMode>;
