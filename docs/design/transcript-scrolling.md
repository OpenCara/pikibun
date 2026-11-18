# Transcript scrolling

A session's transcript (`apps/nsh/src/screens/SessionView.tsx`) opens at its latest message, and goes there again when
the thread shown changes: from the shared conversation to side asks, or from one side ask to another. Otherwise it stays
where the reader put it. New messages carry the view along only when it is already near the bottom
(`maintainVisibleContentPosition`'s `autoscrollToBottomThreshold`). Further up, the jump-to-latest button takes the
reader down.

The effect that scrolls to the end keys on the list and on the thread shown (`actualMode()` and `conversationId()`), and
does nothing while neither has changed since it last scrolled. Re-running on whatever it reads isn't enough:
`actualMode()` reads the session's permissions in ask mode, so it depends on the session record, which the live session
sets again at every reload. A plain effect on it pulled anyone reading an earlier side-ask message back to the bottom
each time the session updated.
