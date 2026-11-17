import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { artifactKinds, artifactResultText, artifactTitle, validArtifactName } from "../../../../../packages/shared/src/artifacts.js";
import { RunnerError } from "../../protocol.js";
import { publishArtifact } from "../artifacts.js";
import { text, type ToolContext } from "./context.js";

export function publishArtifactTool(context: ToolContext): ToolRegistration {
  const { calls } = context;
  return defineTool({ name: "publish_artifact", replay: "safe", description: "Publish something people should look at rather than read in the transcript "
    + "(a report, a chart, a UI mock, a diagram) as an artifact of this session: name (lowercase letters, digits, - and _, at most 64, such as "
    + "\"sales-chart\"), kind (html, svg, markdown or text), content (at most 1 MiB) and optionally title. It is kept with the session, not in the worktree, "
    + "and shows as a card in the transcript and in the session panel's Artifacts tab, to whoever may read the session. Publishing the same name again makes "
    + "its next version; earlier versions stay as they were. HTML and SVG run sandboxed with no network: put every script, style, image and font inline. "
    + "Never publish secrets.", parameters: obj({
    name: str(), kind: StringEnum(artifactKinds), content: str(), title: opt(str()),
  }), execute: async (args, api, _call) => {
    await context.requireSessionTool("publish_artifact");
    if (!validArtifactName(args.name)) throw new RunnerError(400, "name must be lowercase letters, digits, - and _, starting with a letter or digit, at most 64 characters");
    if (args.content.includes("\0") || args.title?.includes("\0")) throw new RunnerError(400, "An artifact must not contain NUL characters");
    await calls.actor(api, true);
    await calls.check(api, "publish_artifact", { write: true });
    const published = await publishArtifact(change => api.commit(change, background), {
      name: args.name, kind: args.kind, title: artifactTitle(args.title, args.name), content: args.content, callId: String(api.taskId), now: new Date(),
    });
    return text(artifactResultText(published));
  } });
}
