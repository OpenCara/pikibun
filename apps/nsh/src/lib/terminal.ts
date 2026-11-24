import { platform } from "nsh";

export const inTerminal: boolean = String(platform.idiom) === "terminal";

export const TUI_PACKAGE = "@pikibun/tui";
export const TUI_UPDATE_COMMAND = `npm install -g ${TUI_PACKAGE}@latest`;
