import type { SessionTunnelRecord } from "../../../packages/shared/src/tunnel";
import { Icon } from "./icons";

/**
 * Beside a session's status in lists, while its server is online through its tunnel (piki:tunnel), as its host last
 * reported it: a label, as the lists' rows are links themselves; the session panel has the address and a Stop button.
 */
export function TunnelTag({ tunnel }: { tunnel: SessionTunnelRecord }) {
  const host = tunnel.url.replace(/^https:\/\//, "");
  return <span className="session-pull success" title={`Online at ${host}`} aria-label={`Online at ${host}`}>
    <Icon name="globe" size={12} />Online
  </span>;
}
