import type { CompactionFailure } from "../../shared/src/types";

export const COMPACTION_FAILED_TITLE = "Context compaction failed";

const causes: Record<CompactionFailure, string> = {
  token_limit: "Pi's summary of the conversation hit its token limit, so the context could not be compacted.",
  tool_call: "Pi's summarizer tried to call a tool instead of writing a summary, so the context could not be compacted.",
  no_text: "Pi's summarizer wrote no summary, so the context could not be compacted.",
  aborted: "Compacting the conversation's context was aborted.",
};

export function compactionFailureText(failure: CompactionFailure, options: { advice?: boolean } = {}): string {
  const cause = causes[failure] ?? "The conversation's context could not be compacted.";
  if (options.advice === false) return cause;
  if (failure === "aborted") return `${cause} Send the message again to retry.`;
  return `${cause} Retrying at the same reasoning level will fail the same way: send the next message with a lower reasoning level, `
    + "or continue in a new session. The host's owner or an admin can also raise this model's reserve tokens under Settings → Hosts → "
    + "the host → Compaction (Pi's compaction.reserveTokens).";
}
