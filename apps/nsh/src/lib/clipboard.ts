import { Clipboard } from "nsh";

export async function writeClipboard(text: string): Promise<void> {
  if (await Clipboard.writeText(text) === "failed") throw new Error("The clipboard didn't take it.");
}
