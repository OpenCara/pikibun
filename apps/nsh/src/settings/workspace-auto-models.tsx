import { View } from "nsh";
import { autoModelAllowed, autoModelKey, autoModelsText, type MemberAutoModels } from "../../../../packages/shared/src/auto-mode";
import { segment, type ModelDefinition, type Workspace } from "../shared";
import { session } from "../lib/auth";
import { createAutoMode } from "../lib/auto-mode";
import { createAction, createResource } from "../lib/resource";
import { CheckControl } from "../form";
import { CardBody, Feedback, Note, ResourceState, Row, Section } from "../ui";

interface Choice { key: string; name: string; provider: string; modelId: string }

export function autoModelChoices(models: readonly ModelDefinition[], workspace: readonly string[] | null): Choice[] {
  const seen = new Map<string, Choice>();
  for (const model of models) {
    const key = autoModelKey(model);
    if (seen.has(key) || !autoModelAllowed(workspace ?? undefined, model)) continue;
    seen.set(key, { key, name: model.name, provider: model.provider, modelId: model.modelId });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

export function WorkspaceAutoModels(props: { workspace: Workspace }) {
  const autoMode = createAutoMode(() => props.workspace.id);
  return (
    <If when={autoMode.enabled()}>
      <AutoModels workspace={props.workspace} />
    </If>
  );
}

function AutoModels(props: { workspace: Workspace }) {
  const base = () => `/api/workspaces/${segment(props.workspace.id)}`;
  const resource = createResource<{ settings: MemberAutoModels }>(() => `${base()}/auto-mode/models`);
  const models = createResource<{ models: ModelDefinition[] }>(() => `${base()}/models`);
  const action = createAction();
  const settings = () => resource.data()?.settings;
  const choices = () => autoModelChoices(models.data()?.models ?? [], settings()?.workspace ?? null);
  const selected = () => settings()?.selected ?? null;
  const missing = () => (selected() ?? []).filter(key => !choices().some(choice => choice.key === key));
  const save = (next: string[] | null, notice: string) => void action.run(async () => {
    await session().api(`${base()}/auto-mode/models`, { method: "PUT", body: { models: next } });
    resource.refresh();
  }, notice);
  const chosen = (key: string) => selected() === null || selected()!.includes(key);
  const toggle = (choice: Choice, on: boolean) => {
    const current = selected() ?? choices().map(item => item.key);
    const next = on ? [...current.filter(key => key !== choice.key), choice.key] : current.filter(key => key !== choice.key);
    if (!next.length) return;
    const every = choices().every(item => next.includes(item.key)) && next.every(key => choices().some(item => item.key === key));
    save(every ? null : next, on ? `Auto may now choose ${choice.name} for your messages here.` : `Auto no longer chooses ${choice.name} for your messages here.`);
  };
  const lastOne = (key: string) => chosen(key) && choices().filter(item => chosen(item.key)).length <= 1 && !missing().length;
  return (
    <Section title="Your Auto models" testID="workspace-auto-models" info={<View style={{ gap: 8 }}>
      <Note>Your own choice, in this workspace; each member makes theirs. When you send a message with Auto, it chooses its model only among the ones you keep here, and picks the reasoning for it as before.</Note>
      <Note>Auto never goes beyond what the workspace allows: its owners and admins can limit auto mode's models under Extensions, and only models the session's host offers can be chosen. A message Auto can't place is refused, so choose a model yourself there.</Note>
    </View>}>
      <ResourceState inline loading={(resource.loading() && !resource.data()) || (models.loading() && !models.data())} error={resource.error() || models.error()}
        retry={() => { resource.refresh(); models.refresh(); }}>
        <If when={settings()}>
          {current => (
            <>
              <Row title="Every model" testID="auto-models-every"
                hint={current().selected === null
                  ? current().workspace ? `Auto chooses among every model the workspace allows it (${autoModelsText(current().workspace!)})` : "Auto chooses among every model the session's host offers"
                  : `Auto chooses only among the ${current().selected!.length === 1 ? "model" : `${current().selected!.length} models`} you keep below`}
                trailing={<CheckControl testID="auto-models-every-toggle" label="Let Auto choose among every model" checked={current().selected === null} disabled={action.busy() || !choices().length}
                  onChange={every => save(every ? null : choices().map(item => item.key), every ? "Auto may now choose any model the workspace allows for your messages here."
                    : "Auto now chooses only among the models you keep here. Uncheck the ones it shouldn't use.")} />} />
              <Each of={choices()} key={choice => choice.key}>
                {choice => (
                  <Row title={choice().name} hint={choice().key} testID={`auto-model-${choice().key}`}
                    trailing={<CheckControl testID={`auto-model-toggle-${choice().key}`} label={`Let Auto choose ${choice().name}`} checked={chosen(choice().key)}
                      disabled={action.busy() || current().selected === null || lastOne(choice().key)} onChange={on => toggle(choice(), on)} />} />
                )}
              </Each>
              <If when={!choices().length}>
                <CardBody><Note>No host here offers a model you can use that auto mode may choose. Your choice applies once one does.</Note></CardBody>
              </If>
              <If when={missing().length}>
                <CardBody><Note testID="auto-models-missing">{`Also kept, though no host here offers ${missing().length === 1 ? "it" : "them"} to you now: ${missing().join(", ")}.`}</Note></CardBody>
              </If>
            </>
          )}
        </If>
      </ResourceState>
      <If when={action.error() || action.notice()}><CardBody><Feedback error={action.error()} notice={action.notice()} /></CardBody></If>
    </Section>
  );
}
