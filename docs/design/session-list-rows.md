# Session list rows

The session list (`apps/nsh/src/screens/SessionList.tsx`) builds its rows again whenever the sessions or workspaces
reload: every 10 to 30 seconds while polling, and when a session is opened. Each build makes new row objects.

Native Shell's lists on the web (`web/browser/list.js` in Native Shell 0.6.1) tell which rows changed by the rows'
identity, not by `keyExtractor`: the rows between the first and the last one that is a different object are spliced
out and in again. A spliced row loses its measured height and is laid out at `estimatedItemSize` until it is measured
again, and while the list is scrolled down the list moves its offset to keep the first visible row in place by those
estimated heights. With every row new, each reload made the whole list jump between estimated and real heights (rows
seemed to change height for a moment) and moved it a little up each time a session was opened. The native platforms
diff by key and never showed it.

So the list passes its rows through `stableRows` (`apps/nsh/src/lib/stable-rows.ts`): a row equal, value for value, to
the one with its key in the last build is that same object, and only rows that really changed are spliced. Its
`estimatedItemSize` is near the rows' real heights too, so a row that did change barely moves before it is measured.
