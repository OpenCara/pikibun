import { lifecycle as nshLifecycle, type Accessor } from "nsh";

export type Lifecycle = "active" | "inactive" | "background";

export const lifecycle: Accessor<Lifecycle> = typeof nshLifecycle === "function" ? nshLifecycle : () => "active";
