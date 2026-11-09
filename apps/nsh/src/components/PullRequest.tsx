import { Text } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { pullRequestLabel, pullRequestRepository, pullRequestStateLabels, pullRequestStateTones, type SessionPullRequest } from "../shared";
import { openExternal } from "../lib/links";
import { Icon } from "../icons";
import { palette, radius, text } from "../theme";

export { pullRequestLabel, pullRequestRepository };

/** "Pull request #12 in owner/repo: CI failed", or the URL when it names no repository this recognizes. */
export function pullRequestTitle(pull: SessionPullRequest): string {
  const repository = pullRequestRepository(pull.url);
  const state = pull.state ? `: ${pullRequestStateLabels[pull.state]}` : "";
  return repository ? `Pull request ${pullRequestLabel(pull)} in ${repository}${state}` : `${pull.url}${state}`;
}

/** The color of a pull request's state: merged in its own purple, the others in their tone's. */
export function pullRequestColor(pull: SessionPullRequest): string {
  const tone = pull.state && pullRequestStateTones[pull.state];
  return tone === "merged" ? palette().merged : tone && tone !== "neutral" ? palette().tones[tone].text : palette().muted;
}

/**
 * The open session's header: a link to its pull request (.session-pull-link), opened in the browser. `compact` (phones)
 * shows only the icon and the number, in the state's color; the label names it all.
 */
export function PullRequestLink(props: { pull: SessionPullRequest; compact?: boolean }) {
  const label = () => (props.pull.number === undefined ? "Pull request" : `PR #${props.pull.number}`);
  const state = () => (props.pull.state ? pullRequestStateLabels[props.pull.state] : "");
  return (
    <BaseButton testID="session-pull-request" accessibilityLabel={pullRequestTitle(props.pull)} onPress={() => openExternal(props.pull.url)}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 24, paddingHorizontal: 8, borderRadius: radius.pill, borderWidth: 1,
        borderColor: palette().border, backgroundColor: palette().control }}
      hoverStyle={{ backgroundColor: palette().hover }} activeStyle={{ opacity: 0.7 }}>
      <Icon name="pull-request" size={12} color={pullRequestColor(props.pull)} />
      <Text style={{ numberOfLines: 1, fontSize: text.caption, color: palette().text }}>
        {props.compact ? pullRequestLabel(props.pull) : `${label()}${state() ? ` · ${state()}` : ""}`}
      </Text>
      <If when={!props.compact}><Icon name="external-link" size={12} color={palette().muted} /></If>
    </BaseButton>
  );
}
