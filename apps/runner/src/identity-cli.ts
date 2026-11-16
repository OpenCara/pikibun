import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { promptHidden } from "./connect-cli.js";
import { identityDirectory, IdentityStore } from "./identity.js";
import { ConnectorSetupError, RunnerError } from "./protocol.js";

const HELP = `Usage: pikibun identity <command> [options]

Your identity is a key kept on this computer, shared by every connection of yours here
(pikibun connect, pikibun serve and the app's host), whichever server each is paired with.
Sessions in your private workspace belong to it, not to a server: pair this computer with
another server and they can be brought there (Private workspace > Other servers' sessions).

Commands:
  show                    Your identity's public key, and the portable sessions on this computer
  export --out FILE       Write an encrypted copy of your identity, for a backup or another computer
  import FILE             Use an exported identity on this computer (--replace to swap out one it has)
  rotate                  Replace the key with a new one, signed over by the old one; servers follow
                          the next time each connection connects
  reset                   Make a new key without the old one, for a key that leaked or was lost

Options:
  --identity-dir PATH     Where the identity is kept (default ~/.local/share/pikibun/identity)
  --replace               With import: replace this computer's identity
  --help                  Show this help

Passphrases are asked for at a hidden prompt, or read from PIKIBUN_IDENTITY_PASSPHRASE.
`;

async function passphrase(confirm: boolean): Promise<string> {
  const given = process.env.PIKIBUN_IDENTITY_PASSPHRASE;
  if (given !== undefined) return given;
  const first = await promptHidden("Passphrase (hidden): ", "Entering the passphrase", "passphrase character", /^[\x20-\x7e]$/);
  if (confirm && await promptHidden("Passphrase again: ", "Entering the passphrase", "passphrase character", /^[\x20-\x7e]$/) !== first) {
    throw new ConnectorSetupError("The passphrases don't match.");
  }
  return first;
}

async function confirmed(word: string, warning: string): Promise<void> {
  process.stderr.write(warning);
  if (!process.stdin.isTTY) throw new ConnectorSetupError(`Run this in a terminal to confirm it.`);
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    if ((await prompt.question(`Type "${word}" to continue: `).catch(() => "")).trim() !== word) throw new ConnectorSetupError("Not confirmed; nothing changed.");
  } finally { prompt.close(); }
}

export async function identityMain(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
    help: { type: "boolean" }, "identity-dir": { type: "string" }, out: { type: "string" }, replace: { type: "boolean" },
  } });
  const [command, ...rest] = positionals;
  if (values.help || command === undefined) { process.stdout.write(HELP); return; }
  const store = new IdentityStore(identityDirectory(values["identity-dir"]));
  try {
    if (command === "show" && !rest.length) {
      const key = await store.key();
      process.stdout.write(`Identity ${key.publicKey}\nKept in ${store.root} since ${key.createdAt}${key.rotations.length ? `, after ${key.rotations.length} rotation${key.rotations.length === 1 ? "" : "s"}` : ""}\n`);
      const entries = await store.entries();
      process.stdout.write(entries.length ? `${entries.length} portable session${entries.length === 1 ? "" : "s"} on this computer:\n` : "No portable sessions on this computer yet.\n");
      for (const entry of entries) process.stdout.write(`  ${entry.sessionId}  ${entry.directory}\n`);
      return;
    }
    if (command === "export" && !rest.length) {
      if (!values.out) throw new ConnectorSetupError("export needs --out FILE.");
      const sealed = await store.exportKey(await passphrase(true));
      await writeFile(resolve(values.out), sealed, { mode: 0o600, flag: "wx" });
      process.stdout.write(`Wrote your encrypted identity to ${resolve(values.out)}. Keep it, and its passphrase, private.\n`);
      return;
    }
    if (command === "import" && rest.length === 1) {
      const key = await store.importKey(await readFile(resolve(rest[0]!), "utf8"), await passphrase(false), { replace: values.replace === true });
      process.stdout.write(`This computer now uses identity ${key}. Restart its connections so their servers learn it.\n`);
      return;
    }
    if (command === "rotate" && !rest.length) {
      const { previous, next } = await store.rotate();
      process.stdout.write(`Rotated ${previous} to ${next}. Restart this computer's connections so their servers follow.\n`);
      return;
    }
    if (command === "reset" && !rest.length) {
      await confirmed("reset", "A reset makes a new key without the old one. Your sessions on this computer stay yours; each server forgets the old key\n"
        + "once a connection of yours sends the new one, and sessions on other computers with the old key stay with it.\n");
      const { previous, next } = await store.reset();
      process.stdout.write(`${previous ? `Replaced ${previous} with` : "Made"} ${next}. Restart this computer's connections.\n`);
      return;
    }
  } catch (error) {
    if (error instanceof RunnerError) throw new ConnectorSetupError(`${error.message}.`);
    throw error;
  }
  throw new ConnectorSetupError(`Unknown identity command: ${[command, ...rest].join(" ")}. Run "pikibun identity --help".`);
}
