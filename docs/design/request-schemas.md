# Request schemas

Review 268, finding 9: request bodies are checked by hand in each route. A route reads a JSON object
(`jsonObject`), compares its keys with the ones it takes, and checks each field with `text`, `identifier` and
`userIdentifier` from `http.ts`, or with a parser from `packages/shared` (`parseGroupTools`, `parseNetworkPolicy`,
`parseWorkspaceExtension`). About 80 routes do this, each in its own way. The checks are correct, but they cost
three things:

- **Nothing states what a route takes.** The shape is spread over `Object.keys` comparisons and `typeof` checks, so
  a reader or a generated client can't learn it from one place.
- **The type follows from casts.** After the checks, `input.childModels as boolean` tells TypeScript what the checks
  meant, and nothing makes the two agree.
- **Each route finds its own way to reject unknown keys and empty changes.** Some routes reject them, some ignore them.

## What the server does now

`apps/server/src/schemas.ts` checks a body against a zod schema: `body(c, schema, { maxBytes, message })`. It reads the
body with `jsonObject`, so the media type, size and JSON checks stay as they were. It then answers the first issue
as `400 invalid_input`, with the issue's message or the route's one `message`, and returns the parsed value with its
type.

- **Field schemas** (`text`, `identifier`, `userIdentifier`) give the messages the hand-written checks gave
  (`Invalid name.`), and `parsed(parseX, fallback)` wraps a parser from `packages/shared`, keeping its error message.
- **`fields(shape, message, { required, some })`** states a body as the routes checked it: first its keys (no unknown
  ones, the required ones present, at least one with `some`), answered with the route's message, and only then each
  field. A plain `z.strictObject` reports a field's fault before an unknown key, and a union's fault as zod's own
  "Invalid input", so routes use `fields`, not `z.strictObject`, where they name the shape and a field differently.

`tests/request-schemas.test.ts` pins this order, and the converted routes' tests pin their messages, so a converted
route answers clients and tests as before.

`tool-groups.ts`, `child-session-settings.ts` and `transcript-settings.ts` use it. Their schemas (`newGroup`,
`groupChange`, `memberGroup`, `transcriptChange`) state each body, and the routes no longer cast.

## Why not everything at once, and not in packages/shared

- **Routes move when they change.** Each conversion has to keep the route's answers (status, code, message, and which
  of several faults is named first) or change tests and clients with it. Converting 80 routes in one change would
  hide behaviour changes in a large diff. New routes use `body()`, and a route moves when it is next changed. The
  hand-written helpers stay in `http.ts` until the last route has moved.
- **The parsers in `packages/shared` stay plain TypeScript.** `packages/shared` may not import npm packages
  (`tests/package-boundaries.test.ts`). It and `packages/client` stay platform-neutral, because the Native Shell client
  (`apps/nsh`) builds them for every platform it runs on, and zod would add to what it ships. The server wraps them with
  `parsed()` instead, so the same parser checks a request on both sides and the server still gets a schema. Sharing zod
  schemas with the client would mean dropping that rule for one package; nothing needs it yet.
- **The authority's routes move under its own review.** Its bodies (sign-in, credentials, the GitHub broker) are part of
  the security boundary (`authority.md`), so they move one at a time with their tests, not as part of a mechanical sweep.
  `schemas.ts` imports only `http.ts` and zod, so the boundary test counts it with the authority's infrastructure
  (`tests/authority-boundary.test.ts`). The first to move are the bodies taken before anyone is signed in:
  `POST /api/auth/native/code` and `POST /api/me/app-codes` (`authority/app-codes.ts`) and `POST /api/auth/native/local`
  (`authority/auth.ts`). A malformed sign-in code is still `400 invalid_grant`, through the custom issue's `code`.
