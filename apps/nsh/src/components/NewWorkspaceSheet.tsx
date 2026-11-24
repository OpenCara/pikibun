import { signal } from "nsh";
import { defaultWorkspacePreset, workspacePreset, workspacePresets, type WorkspacePreset } from "../../../../packages/shared/src/workspace-presets";
import type { Workspace } from "../shared";
import { useAppData } from "../lib/app-data";
import { session } from "../lib/auth";
import { createAction } from "../lib/resource";
import { Field, Select, TextField } from "../form";
import { Button, Feedback, FormSheet } from "../ui";

export function NewWorkspaceSheet(props: { open: boolean; onClose: () => void; created: (workspace: Workspace) => void }) {
  const data = useAppData();
  const name = signal("");
  const preset = signal<WorkspacePreset>(defaultWorkspacePreset);
  const action = createAction();
  function create() {
    if (action.busy() || !name().trim()) return;
    void action.run(async () => {
      const result = await session().api<{ workspace: Workspace }>("/api/workspaces", { method: "POST",
        body: { name: name().trim(), ...(preset() === defaultWorkspacePreset ? {} : { preset: preset() }) } });
      name.set("");
      preset.set(defaultWorkspacePreset);
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
      <Field label="Starts as" hint={`${workspacePreset(preset()).summary}. Every part of it is a setting you can change afterwards`}>
        <Select<WorkspacePreset> testID="new-workspace-preset" label="Starts as" value={preset()} disabled={action.busy()} onChange={value => preset.set(value)}
          options={workspacePresets.map(id => ({ value: id, label: `${workspacePreset(id).title}${id === defaultWorkspacePreset ? " (recommended)" : ""}` }))} />
      </Field>
      <Feedback error={action.error()} />
    </FormSheet>
  );
}
