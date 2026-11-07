import { openUrl, Text, View, type JSX } from "nsh";
import { automaticNote, containsRedaction, extensionToolArguments, extensionToolNotice, REDACTED, type ApprovalRecord } from "../shared";
import type { GitHubMergeMethod, GitHubMergeOperation, GitPushOperation, PermissionNeed, PermissionRequest } from "../../../../packages/shared/src/types";
import { timestamp } from "../lib/format";
import { createUsername } from "../lib/people";
import { monospace, palette, type Tone } from "../theme";
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
    <View selectable style={{ borderRadius: 8, padding: 10, backgroundColor: palette().code }}>
      <Text testID={props.testID} style={{ fontFamily: monospace, fontSize: 12, lineHeight: 17, color: palette().text }}>{props.children}</Text>
    </View>
  );
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
  const kindLabel = () => {
    const op = operation();
    return op.kind === "permission" ? "Permission" : op.kind === "extension.tool" ? `Extension tool · ${op.tool}` : op.kind;
  };
  const repin = () => (operation().kind === "git.repin" && props.approval.status === "executed" ? repinnedSession(props.approval.result) : null);
  return (
    <Card testID={`approval-${props.approval.id}`}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <Text style={{ fontSize: 14, fontWeight: "700", color: palette().text }}>{kindLabel()}</Text>
        <View style={{ flex: 1 }} />
        <If when={props.approval.unbounded}><Badge tone="warning">No resource limits</Badge></If>
        <If when={containsRedaction(operation())}><Badge tone="warning">Secret hidden</Badge></If>
        <If when={props.approval.automatic}><Badge tone="warning">Auto-approved</Badge></If>
        <Badge tone={approvalTone[props.approval.status]} dot={props.approval.status === "executing"}>{props.approval.status}</Badge>
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
            <Code testID="approval-operation">
              {(() => { const op = operation(); return op.kind === "extension.tool" ? extensionToolArguments(op) : JSON.stringify(op, null, 2); })()}
            </Code>
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
