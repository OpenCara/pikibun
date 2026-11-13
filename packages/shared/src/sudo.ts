export const sudoLimits = Object.freeze({ password: 1024, prompt: 200, command: 400, waitMs: 5 * 60_000 });

export interface SudoAnswer {
  id: string;
  password?: string;
  decline?: true;
  nonce?: string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseSudoAnswer(value: unknown): SudoAnswer {
  if (!isPlainObject(value) || Object.keys(value).some(key => !["id", "password", "decline", "nonce"].includes(key))) {
    throw new Error("Answer a sudo prompt with its id and a password, or decline: true.");
  }
  if (typeof value.id !== "string" || !ID.test(value.id)) throw new Error("Invalid sudo prompt id.");
  if (value.nonce !== undefined && (typeof value.nonce !== "string" || !ID.test(value.nonce))) throw new Error("Invalid nonce.");
  const nonce = value.nonce === undefined ? {} : { nonce: value.nonce as string };
  if (value.decline !== undefined) {
    if (value.decline !== true || value.password !== undefined) throw new Error("Give a password or decline: true, not both.");
    return { id: value.id, decline: true, ...nonce };
  }
  if (typeof value.password !== "string" || !value.password || value.password.length > sudoLimits.password) {
    throw new Error(`Give the password, at most ${sudoLimits.password} characters, or decline: true.`);
  }
  if (/[\0\r\n]/.test(value.password)) throw new Error("A password can't hold line breaks.");
  return { id: value.id, password: value.password, ...nonce };
}

export function sudoPromptText(prompt: unknown): string {
  const shown = typeof prompt === "string" ? prompt.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, sudoLimits.prompt) : "";
  return shown || "Password:";
}

export function sudoCommandText(command: string | undefined): string | undefined {
  const shown = command?.replace(/[\x00-\x08\x0b-\x1f\x7f]+/g, " ").trim();
  if (!shown) return undefined;
  return shown.length > sudoLimits.command ? `${shown.slice(0, sudoLimits.command - 1)}…` : shown;
}
