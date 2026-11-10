import { Text, View } from "nsh";
import { Button as BaseButton, Progress } from "nsh/base";
import { appUpdate, formatBytes, isVersion, type AppUpdater, type UpdatePhase } from "../lib/app-update";
import { openExternal } from "../lib/links";
import { palette, radius, text } from "../theme";
import { Button, CardBody, Feedback, IconButton, Row, Small } from "../ui";

const percent = (phase: UpdatePhase) => (phase.name === "downloading" && phase.total > 0 ? Math.min(100, Math.floor((phase.loaded / phase.total) * 100)) : 0);

function stepLabel(phase: UpdatePhase, version: string): string {
  switch (phase.name) {
    case "downloading": return phase.total > 0 ? `Downloading Pikibun ${version}… ${percent(phase)}%` : `Downloading Pikibun ${version}…`;
    case "installing": return `Installing Pikibun ${version}…`;
    case "restarting": return "Restarting Pikibun…";
    default: return "";
  }
}

function UpdateProgress(props: { updater: AppUpdater; testID?: string; detail?: boolean }) {
  const phase = () => props.updater.phase();
  const version = () => props.updater.available()?.version ?? "";
  return (
    <View testID={props.testID} style={{ gap: 6 }}>
      <Text testID={props.testID ? `${props.testID}-label` : undefined} style={{ fontSize: text.small, color: palette().text, numberOfLines: 1 }}>{stepLabel(phase(), version())}</Text>
      <Progress testID={props.testID ? `${props.testID}-bar` : undefined} accessibilityLabel={stepLabel(phase(), version())}
        value={phase().name === "downloading" ? percent(phase()) : 100} indeterminate={phase().name === "downloading" && (phase() as { total: number }).total <= 0}
        trackStyle={{ height: 4, borderRadius: radius.pill, overflow: "hidden", backgroundColor: palette().control }}
        indicatorStyle={{ height: 4, borderRadius: radius.pill, backgroundColor: palette().accent }} />
      <If when={props.detail && phase().name === "downloading" && (phase() as { total: number }).total > 0}>
        <Small>{`${formatBytes((phase() as { loaded: number }).loaded)} of ${formatBytes((phase() as { total: number }).total)}`}</Small>
      </If>
    </View>
  );
}

const inProgress = (updater: AppUpdater) => {
  const name = updater.phase().name;
  return name === "downloading" || name === "installing" || name === "restarting";
};

export function SidebarUpdate(props: { onDetails: () => void }) {
  const updater = appUpdate();
  if (!updater.offered) return <></>;
  const update = () => updater.available();
  const press = () => {
    if (update()?.asset) void updater.install();
    else if (update()) openExternal(update()!.page);
  };
  return (
    <If when={update()}>
      <View testID="sidebar-update" style={{ gap: 6, paddingHorizontal: 8, paddingVertical: 6 }}>
        <If when={inProgress(updater)}
          else={
            <>
              <Button testID="sidebar-update-button" small block variant="outline" icon={update()?.asset ? "download" : "external-link"}
                label={`Update to ${update()?.version ?? ""}`} onPress={press} />
              <If when={updater.phase().name === "failed"}>
                <BaseButton testID="sidebar-update-error" accessibilityLabel="The update didn't finish: see why" onPress={props.onDetails}
                  style={{ paddingHorizontal: 2 }} hoverStyle={{ opacity: 0.8 }} activeStyle={{ opacity: 0.6 }}>
                  <Text style={{ fontSize: text.caption, lineHeight: 17, color: palette().tones.danger.text }}>The update didn't finish: see why</Text>
                </BaseButton>
              </If>
            </>
          }>
          <UpdateProgress updater={updater} testID="sidebar-update-progress" />
        </If>
      </View>
    </If>
  );
}

export function UpdateIconButton(props: { onOpen: () => void }) {
  const updater = appUpdate();
  if (!updater.offered) return <></>;
  return (
    <If when={updater.available()}>
      {update => <IconButton testID="update-available" icon="download" tone="info" label={`Pikibun ${update().version} is available`} onPress={props.onOpen} />}
    </If>
  );
}

export function AppUpdateRows() {
  const updater = appUpdate();
  const version = () => (isVersion(updater.current) ? `Pikibun ${updater.current}` : "Pikibun (development build)");
  const update = () => updater.available();
  const failure = () => { const phase = updater.phase(); return phase.name === "failed" ? phase.error : ""; };
  const retry = () => { if (update()?.asset) void updater.install(); else void updater.check(); };
  const checkHint = () => (updater.checking() ? "Checking GitHub for a newer release…"
    : updater.checkError() ? updater.checkError()
    : updater.checked() ? "Pikibun is up to date"
    : "Pikibun checks GitHub for new releases");
  return (
    <>
      <Row title="Version" trailing={version()} testID="app-version" />
      <If when={updater.offered}>
        <If when={update()}
          else={
            <Row testID="app-update-check" title="Updates" hint={checkHint()}
              trailing={<Button testID="app-update-check-button" small variant="outline" icon="refresh" label="Check now" busy={updater.checking()} onPress={() => void updater.check()} />} />
          }>
          {available => (
            <If when={!inProgress(updater)}
              else={<CardBody testID="app-update-progress"><UpdateProgress updater={updater} testID="app-update-progress-bar" detail /></CardBody>}>
              <Row testID="app-update" title={`Pikibun ${available().version} is available`}
                hint={available().asset ? "It downloads here, installs, and Pikibun restarts. Sessions carry on on the server; this computer's host reconnects once Pikibun is back."
                  : "There is no package for this computer in the release: download it from the release page."}
                trailing={
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Button small variant="ghost" label="What's new" onPress={() => openExternal(available().page)} />
                    <If when={available().asset} else={<Button testID="app-update-page" small variant="primary" icon="external-link" label="Release page" onPress={() => openExternal(available().page)} />}>
                      <Button testID="app-update-button" small variant="primary" icon="download" label="Update and restart" onPress={() => void updater.install()} />
                    </If>
                  </View>
                } />
            </If>
          )}
        </If>
        <If when={failure()}>
          <CardBody testID="app-update-failed">
            <Feedback error={failure()} />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Button testID="app-update-retry" small variant="outline" icon="refresh" label="Try again" disabled={updater.checking()} onPress={retry} />
              <If when={update()}>{available => <Button small variant="ghost" icon="external-link" label="Release page" onPress={() => openExternal(available().page)} />}</If>
            </View>
          </CardBody>
        </If>
        <If when={updater.notice()}>
          <CardBody testID="app-update-notice"><Feedback notice={updater.notice()} /></CardBody>
        </If>
      </If>
    </>
  );
}
