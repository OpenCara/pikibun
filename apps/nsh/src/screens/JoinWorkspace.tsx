import { View } from "nsh";
import { palette } from "../theme";
import { EmptyState } from "../ui";

/**
 * A workspace's invite link (`#/join/<token>`), once signed in: what the workspace is and a request to join it, or
 * where the request stands. `onDone` leaves the page.
 */
export function JoinWorkspace(_props: { token: string; onDone: () => void }) {
  return (
    <View testID="join-workspace" style={{ flex: 1, backgroundColor: palette().background }}>
      <EmptyState title="Not here yet">Invite links are still being moved to this app.</EmptyState>
    </View>
  );
}
