import { signal } from "nsh";
import type { Workspace } from "../shared";
import { useAppData } from "../lib/app-data";
import { session } from "../lib/auth";
import { createAction } from "../lib/resource";
import { Field, TextField } from "../form";
import { Button, Feedback, FormSheet } from "../ui";

/** A new workspace, as the web app's NewWorkspaceSheet: its name; once created, `created` takes the person on to it. */
export function NewWorkspaceSheet(props: { open: boolean; onClose: () => void; created: (workspace: Workspace) => void }) {
  const data = useAppData();
  const name = signal("");
  const action = createAction();
  function create() {
    if (action.busy() || !name().trim()) return;
    void action.run(async () => {
      const result = await session().api<{ workspace: Workspace }>("/api/workspaces", { method: "POST", body: { name: name().trim() } });
      name.set("");
      data.refreshWorkspaces();
      data.setLastWorkspaceId(result.workspace.id);
      props.onClose();
      props.created(result.workspace);
    });
  }
  return (
    <FormSheet open={props.open} title="New workspace" onClose={() => { if (!action.busy()) props.onClose(); }} testID="new-workspace-sheet"
      footer={<>
        <Button label="Cancel" disabled={action.busy()} onPress={props.onClose} />
        <Button testID="new-workspace-create" variant="primary" label={action.busy() ? "Creating…" : "Create workspace"} disabled={action.busy() || !name().trim()} onPress={create} />
      </>}>
      <Field label="Name" hint="A shared home for repositories, people, agents and sessions">
        <TextField testID="new-workspace-name" value={name()} onChange={value => name.set(value)} maxLength={120} placeholder="The field studio" autoFocus onSubmit={create} />
      </Field>
      <Feedback error={action.error()} />
    </FormSheet>
  );
}
