import { lifecycle as nshLifecycle, type Accessor } from "nsh";

export type Lifecycle = "active" | "inactive" | "background";

/**
 * Whether the app is in the foreground (reactive): NSH's `lifecycle`, where the runtime has it. NSH 0.4's web runtime
 * doesn't export it, and calling the missing import threw while the signed-in screens were being made, so the web app
 * stayed on "Loading…"; there the page counts as always active. Import it from here, never from "nsh".
 */
export const lifecycle: Accessor<Lifecycle> = typeof nshLifecycle === "function" ? nshLifecycle : () => "active";
