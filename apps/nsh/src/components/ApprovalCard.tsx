import { openUrl, signal, Text, View, type JSX } from "nsh";
import { Button as BaseButton } from "nsh/base";
import { automaticNote, containsRedaction, extensionToolArguments, extensionToolNotice, REDACTED, type ApprovalRecord } from "../shared";
import type { GitHubMergeMethod, GitHubMergeOperation, GitPushOperation, PermissionNeed, PermissionRequest } from "../../../../packages/shared/src/types";
import { timestamp } from "../lib/format";
import { createUsername } from "../lib/people";
import { Icon, type IconName } from "../icons";
import { monospace, palette, radius, text, type Tone } from "../theme";
import { Badge, Banner, Button, Card, Small } from "../ui";

const approvalTone: Record<ApprovalRecord["status"], Tone> = {
  pending: "warning", approved: "info", executing: "running", executed: "success", denied: "neutral", interrupted: "warning", failed: "danger",
};

const permissionNeedText: Record<PermissionNeed, string> = {
  tool: "A tool this agent doesn't include",
  write: "A change in a Read-only message",
  "unbounded-shell": "No resource limits: this host has none set up for commands. The command still runs in the sandbox, offline and for at most the host's command time limit, but with no cap on CPU, memory, processes or disk.",
  audience: "Sharing another session: this session's readers would see what the agent reads from a session they can't open themselves.",
};
/** Tools whose effect gets its own approval card after the permission, unless the message auto-approves. */
const approvedTools: readonly string[] = ["bash", "git", "node", "python", "rust", "go", "dotnet", "browser", "make", "git_commit", "git_push", "github_comment", "github_merge", "github_issue", "host_bash", "git_repin"];

const mergeMethodLabels: Record<GitHubMergeMethod, string> = { merge: "Merge commit", squash: "Squash and merge", rebase: "Rebase and merge" };

function Code(props: { children?: JSX.Element; testID?: string }) {
  return (
    <View selectable style={{ borderRadius: radius.medium, borderWidth: 1, borderColor: palette().border, padding: 10, backgroundColor: palette().code }}>
      <Text testID={props.testID} style={{ fontFamily: monospace, fontSize: 12, lineHeight: 18, color: palette().text }}>{props.children}</Text>
    </View>
  );
}

type Operation = ApprovalRecord["operation"];

/** What a card asks, in a few words, and its icon. */
function heading(op: Operation): { icon: IconName; title: string } {
  switch (op.kind) {
    case "program": return { icon: "terminal", title: `Run ${op.tool}` };
    case "bash": return { icon: "terminal", title: "Run a command" };
    case "host.bash": return { icon: "monitor", title: "Run a command on the host" };
    case "git.commit": return { icon: "branch", title: "Commit" };
    case "git.push": return { icon: "branch", title: op.tag !== undefined ? "Push a tag" : op.pullRequest ? "Push and open a pull request" : "Push" };
    case "github.merge": return { icon: "pull-request", title: "Merge a pull request" };
    case "github.issue": return { icon: "pull-request", title: "Open an issue" };
    case "github.comment": return { icon: "pull-request", title: "Comment on GitHub" };
    case "permission": return { icon: "shield-check", title: `Permission for ${op.tool}` };
    case "extension.tool": return { icon: "zap", title: `Extension tool · ${op.tool}` };
    case "git.repin": return { icon: "branch", title: "Repin a repository" };
    default: return { icon: "shield-check", title: (op as { kind: string }).kind };
  }
}

/**
 * The exact text an operation runs or writes, when the card can show the whole operation by it: the command of a
 * program, shell or host command (with the program's tool in the title), a commit's message. Other operations show
 * their JSON as it is.
 */
function exactText(op: Operation): string | null {
  switch (op.kind) {
    case "program": case "bash": return op.command;
    case "host.bash": return `${op.command}\n\n# Time limit: ${op.timeoutSeconds} seconds`;
    case "git.commit": return op.message;
    default: return null;
  }
}

function Detail(props: { label: string; children?: JSX.Element }) {
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <Text style={{ width: 96, fontSize: 13, color: palette().muted }}>{props.label}</Text>
      <View selectable style={{ flex: 1 }}>
        <Text style={{ fontFamily: monospace, fontSize: 13, color: palette().text }}>{props.children}</Text>
      </View>
    </View>
  );
}

/** The server hides what looks like a secret from everyone; a decision still uses the real value. */
function HiddenSecretNote() {
  return (
    <Text testID="approval-secret-note" style={{ fontSize: 13, lineHeight: 18, color: palette().text }}>
      Something that looks like a secret is shown as {REDACTED}. Allowing or approving this uses the real value, so make sure it belongs here.
    </Text>
  );
}

function PermissionSummary(props: { request: PermissionRequest; pending: boolean }) {
  return (
    <>
      <Text style={{ fontSize: 14, lineHeight: 20, color: palette().text }}>
        <Text style={{ fontFamily: monospace }}>{props.request.tool}</Text> {props.pending ? "needs the session owner's permission for:" : "asked the session owner's permission for:"}
      </Text>
      <Each of={props.request.needs}>
        {need => <Text style={{ fontSize: 13, color: palette().text }}>• {permissionNeedText[need()]}</Text>}
      </Each>
      <If when={props.request.target}>
        {target => <Code>{target()}</Code>}
      </If>
      <If when={props.pending && containsRedaction(props.request.target)}><HiddenSecretNote /></If>
      <If when={props.pending && approvedTools.includes(props.request.tool)}>
        <Small>Allowing it doesn't run anything yet: the operation still gets its own approval, unless the message auto-approves.</Small>
      </If>
    </>
  );
}

function GitPushSummary(props: { operation: GitPushOperation }) {
  return (
    <View style={{ gap: 4 }}>
      <Detail label="Repository">{props.operation.repository}</Detail>
      <If when={props.operation.tag !== undefined}>
        <Detail label="New tag">{props.operation.tag ?? ""}</Detail>
      </If>
      <Detail label={props.operation.tag !== undefined ? "On branch (not moved)" : "Branch"}>{props.operation.branch}</Detail>
      <Detail label="Commit">{props.operation.commit.slice(0, 12)}</Detail>
      <If when={props.operation.pullRequest}>
        {pull => <Detail label="Pull request">{`${pull().title} → ${pull().base ?? "default branch"}`}</Detail>}
      </If>
    </View>
  );
}

function GitHubMergeSummary(props: { operation: GitHubMergeOperation }) {
  const url = () => `https://github.com/${props.operation.repository}/pull/${props.operation.pull}`;
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Text style={{ width: 96, fontSize: 13, color: palette().muted }}>Pull request</Text>
        <Text role="link" onPress={() => void openUrl(url()).catch(() => undefined)}
          style={{ fontFamily: monospace, fontSize: 13, textDecorationLine: "underline", color: palette().tones.info.text }}>
          {props.operation.repository}#{props.operation.pull}
        </Text>
      </View>
      <Detail label="Head commit">{props.operation.sha.slice(0, 12)}</Detail>
      <Detail label="Method">{mergeMethodLabels[props.operation.method]}</Detail>
    </View>
  );
}

/** The session a repin created, from the executed approval's result; nothing unless it holds a valid session ID. */
function repinnedSession(result?: string): string | null {
  try {
    const value = JSON.parse(result ?? "null");
    return typeof value?.sessionId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.sessionId) ? value.sessionId : null;
  } catch {
    return null;
  }
}

/**
 * One approval record with the exact operation it covers; decision controls, when allowed, come in as children.
 * `onOpenSession` opens the session an executed repin created.
 */
export function ApprovalCard(props: { approval: ApprovalRecord; onOpenSession?: (id: string) => void; children?: JSX.Element }) {
  const name = createUsername();
  const operation = () => props.approval.operation;
  const decision = () => {
    const approval = props.approval;
    const allowed = (decidedBy: string, scope: ApprovalRecord["scope"]) => ` · Allowed by ${name(decidedBy)} ${scope === "session" ? "for the rest of the session" : "for this call"}`;
    return approval.operation.kind === "permission" && approval.status === "approved" && approval.decidedBy
      ? allowed(approval.decidedBy, approval.scope)
      : `${approval.permission ? allowed(approval.permission.decidedBy, approval.permission.scope) : ""}${approval.decidedBy ? ` · Decision by ${name(approval.decidedBy)}` : ""}`;
  };
  const repin = () => (operation().kind === "git.repin" && props.approval.status === "executed" ? repinnedSession(props.approval.result) : null);
  const pending = () => props.approval.status === "pending";
  const showJson = signal(false);
  const exact = () => exactText(operation());
  return (
    <Card testID={`approval-${props.approval.id}`} style={pending() ? { borderColor: palette().tones.warning.border, gap: 12 } : undefined}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <View style={{ width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center",
          backgroundColor: pending() ? palette().tones.warning.background : palette().surfaceRaised }}>
          <Icon name={heading(operation()).icon} size={14} color={pending() ? palette().tones.warning.text : palette().muted} />
        </View>
        <Text style={{ flexShrink: 1, fontSize: text.reading, fontWeight: "600", color: palette().text }}>{heading(operation()).title}</Text>
        <View style={{ flex: 1 }} />
        <If when={props.approval.unbounded}><Badge tone="warning">No resource limits</Badge></If>
        <If when={containsRedaction(operation())}><Badge tone="warning">Secret hidden</Badge></If>
        <If when={props.approval.automatic}><Badge tone="warning">Auto-approved</Badge></If>
        <Badge tone={approvalTone[props.approval.status]} dot={props.approval.status === "executing" || pending()}>{pending() ? "Needs approval" : props.approval.status}</Badge>
      </View>
      <If when={operation().kind === "permission" ? operation() as PermissionRequest : null}
        else={
          <>
            <If when={operation().kind === "host.bash" ? operation() as Extract<ApprovalRecord["operation"], { kind: "host.bash" }> : null}>
              {op => (
                <Banner tone="danger" title="Runs outside the sandbox">
                  {`This command runs as the host's OS user with access to their files, credentials and network, without CPU, memory or disk quotas. It runs in this session's files, which the agent can change, so builds, package scripts and Git hooks or settings there can run the agent's code on the host too. Only the host owner can approve it. The time limit is ${op().timeoutSeconds} seconds.`}
                </Banner>
              )}
            </If>
            <If when={operation().kind === "git.repin" ? operation() as Extract<ApprovalRecord["operation"], { kind: "git.repin" }> : null}>
              {op => (
                <Banner title="Creates a new private session">
                  {`Resolves ${op().repository} at ${op().ref}. Other repository pins stay unchanged. This session's files, commits and conversation stay here; they are not copied. Only the session owner can approve.`}
                </Banner>
              )}
            </If>
            <If when={operation().kind === "extension.tool" ? operation() as Extract<ApprovalRecord["operation"], { kind: "extension.tool" }> : null}>
              {op => <Banner tone="danger" title="Runs on the host, outside the sandbox">{extensionToolNotice(op())}</Banner>}
            </If>
            <If when={operation().kind === "git.push" ? operation() as GitPushOperation : null}>
              {op => <GitPushSummary operation={op()} />}
            </If>
            <If when={operation().kind === "github.merge" ? operation() as GitHubMergeOperation : null}>
              {op => <GitHubMergeSummary operation={op()} />}
            </If>
            <If when={exact() !== null}
              else={
                <Code testID="approval-operation">
                  {(() => { const op = operation(); return op.kind === "extension.tool" ? extensionToolArguments(op) : JSON.stringify(op, null, 2); })()}
                </Code>
              }>
              <Code testID="approval-command">{exact() ?? ""}</Code>
              <BaseButton accessibilityLabel={showJson() ? "Hide the exact operation" : "Show the exact operation"} onPress={() => showJson.update(value => !value)}
                style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", paddingVertical: 2 }} activeStyle={{ opacity: 0.6 }}>
                <Icon name={showJson() ? "chevron-up" : "chevron-down"} size={12} color={palette().muted} />
                <Text style={{ fontSize: text.caption, color: palette().muted }}>{showJson() ? "Hide the exact operation" : "Show the exact operation"}</Text>
              </BaseButton>
              <If when={showJson()}>
                <Code testID="approval-operation">{JSON.stringify(operation(), null, 2)}</Code>
              </If>
            </If>
            <If when={props.approval.status === "pending" && containsRedaction(operation())}><HiddenSecretNote /></If>
          </>
        }>
        {request => <PermissionSummary request={request()} pending={props.approval.status === "pending"} />}
      </If>
      <Small>
        {`Requested by ${name(props.approval.requestedBy)} · ${timestamp(props.approval.createdAt)}${props.approval.automatic ? ` · ${automaticNote(operation())}` : decision()}`}
      </Small>
      <If when={props.approval.result}>
        {result => <Code testID="approval-result">{result()}</Code>}
      </If>
      <If when={props.onOpenSession && repin()}>
        {sessionId => (
          <View style={{ flexDirection: "row" }}>
            <Button testID="approval-open-repin" small label="Open repinned session" onPress={() => props.onOpenSession?.(sessionId() as string)} />
          </View>
        )}
      </If>
      {props.children}
    </Card>
  );
}
