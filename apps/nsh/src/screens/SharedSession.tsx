import { safeArea, View } from "nsh";
import { palette } from "../theme";
import { EmptyState } from "../ui";

/**
 * A session's read-only share link (`#/shared/<token>`): its conversation for anyone holding the link, signed in or
 * not, through the share-link API with the token, which never leaves the fragment otherwise.
 */
export function SharedSession(_props: { token: string }) {
  return (
    <View testID="shared-session" style={{ flex: 1, paddingTop: safeArea().top, backgroundColor: palette().background }}>
      <EmptyState title="Not here yet">Shared sessions are still being moved to this app.</EmptyState>
    </View>
  );
}
