import { homedir } from "node:os";
import type { AuthEvent, AuthInteraction, AuthPrompt, LoginOptions } from "@earendil-works/pi-ai";
import type { LoginEvent, LoginMethodType, LoginPrompt, LoginProvider } from "./app-host-protocol.js";

// Signing Pi in to a provider from the app (`pikibun host --stdio`), as `pi`'s /login does: the provider's own sign-in
// flow (a browser page, a device code, an API key) runs here on the host, through Pi's ModelRuntime, and saves its
// credential in Pi's auth.json here. What the flow shows and asks goes to the app as LoginEvents; the owner's answers come back by prompt
// number. Credentials never cross to the app, and nothing a provider says is passed on unchecked.

/** What of Pi's ModelRuntime signing in needs; tests pass their own. */
export interface LoginRuntime {
  getProviders(): readonly { id: string; name: string; auth: { apiKey?: { name: string; login?: unknown }; oauth?: { name: string; isSubscription?: boolean } } }[];
  listCredentials(): Promise<readonly { providerId: string }[]>;
  login(providerId: string, type: LoginMethodType, interaction: AuthInteraction, options?: LoginOptions): Promise<unknown>;
}

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PROVIDERS = 200;
const text = (value: unknown, limit: number): string | undefined =>
  typeof value === "string" && value.trim() ? value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").slice(0, limit) : undefined;
const label = (value: unknown) => text(value, 200)?.replace(/\s+/g, " ");

/**
 * Pi's runtime on this host, with its own credentials and models, as the connector loads it (local-pi.ts), and this
 * installation's device ID, which some sign-ins send (ChatGPT's): Pi's own, so `pi` and the app share it. Pi's SDK
 * loads only once a sign-in needs it.
 */
export async function piLogin(): Promise<{ runtime: LoginRuntime; deviceId: () => string }> {
  const { ModelRuntime, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  return { runtime, deviceId: () => SettingsManager.create(homedir()).getOrCreateDeviceId() };
}

/** The providers the owner can sign in to here: those with a sign-in of their own, in Pi's order. */
export async function loginProviders(runtime: LoginRuntime): Promise<LoginProvider[]> {
  const signedIn = new Set((await runtime.listCredentials()).map(item => item.providerId));
  const providers: LoginProvider[] = [];
  for (const provider of runtime.getProviders()) {
    const name = label(provider.name);
    if (!PROVIDER_ID.test(provider.id) || !name) continue;
    const methods: LoginProvider["methods"] = [];
    const oauth = provider.auth.oauth;
    if (oauth) methods.push({ type: "oauth", name: label(oauth.name) ?? name, ...(oauth.isSubscription ? { subscription: true } : {}) });
    // Ambient-only API key auth (environment variables, cloud profiles) has no sign-in to run.
    const apiKey = provider.auth.apiKey;
    if (apiKey?.login) methods.push({ type: "api_key", name: label(apiKey.name) ?? `${name} API key` });
    if (methods.length) providers.push({ id: provider.id, name, signedIn: signedIn.has(provider.id), methods });
    if (providers.length >= MAX_PROVIDERS) break;
  }
  return providers;
}

/** Only https pages go to the owner's browser; a provider's loopback callback page is shown, never opened. */
const link = (value: unknown): string | undefined => {
  const url = typeof value === "string" && value.length <= 8192 ? URL.parse(value) : null;
  return url && (url.protocol === "https:" || (url.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname))) ? url.href : undefined;
};

/** What the app may see of a flow's notice, or nothing. */
export function loginEvent(event: AuthEvent): LoginEvent | undefined {
  switch (event.type) {
    case "auth_url": {
      const url = link(event.url);
      const instructions = text(event.instructions, 1000);
      return url ? { kind: "auth-url", url, ...(instructions ? { instructions } : {}) } : undefined;
    }
    case "device_code": {
      const userCode = text(event.userCode, 64);
      const verificationUri = link(event.verificationUri);
      return userCode && verificationUri ? { kind: "device-code", userCode, verificationUri } : undefined;
    }
    case "info": {
      const message = text(event.message, 1000);
      const links = (event.links ?? []).slice(0, 5).flatMap(item => {
        const url = link(item.url);
        const name = label(item.label);
        return url ? [{ url, ...(name ? { label: name } : {}) }] : [];
      });
      return message ? { kind: "info", message, ...(links.length ? { links } : {}) } : undefined;
    }
    case "progress": {
      const message = text(event.message, 1000);
      return message ? { kind: "progress", message } : undefined;
    }
    default: return undefined;
  }
}

function loginPrompt(prompt: AuthPrompt): LoginPrompt {
  const message = text(prompt.message, 1000) ?? "Enter a value.";
  if (prompt.type === "select") {
    return { type: "select", message, options: prompt.options.slice(0, 50).map(option => {
      const description = text(option.description, 500);
      return { id: String(option.id).slice(0, 200), label: label(option.label) ?? String(option.id).slice(0, 200), ...(description ? { description } : {}) };
    }) };
  }
  const placeholder = text(prompt.placeholder, 500);
  return { type: prompt.type, message, ...(placeholder ? { placeholder } : {}) };
}

/** Why a sign-in failed, without what a provider's error may carry (a token in a response it quotes, say). */
export function loginFailure(error: unknown, cancelled: boolean): { cancelled: boolean; message: string } {
  const raw = error instanceof Error ? error.message : "";
  if (cancelled || /^login cancelled$/i.test(raw.trim())) return { cancelled: true, message: "Sign-in cancelled." };
  const message = raw.replace(/[A-Za-z0-9+/_.=-]{32,}/g, "…").replace(/\{[\s\S]*\}/g, "{…}").replace(/\s+/g, " ").trim().slice(0, 300);
  return { cancelled: false, message: message ? `Sign-in failed: ${message}` : "Sign-in failed." };
}

/** A sign-in that ended without a credential: its message is safe to show as is. */
export class LoginError extends Error {
  constructor(message: string, readonly cancelled = false) { super(message); }
}

/** One sign-in under way: Pi's interaction, the prompts waiting for the owner, and its cancellation. */
export class LoginSession {
  private readonly controller = new AbortController();
  private readonly prompts = new Map<number, (value: string) => void>();
  private nextPrompt = 1;
  readonly interaction: AuthInteraction;

  constructor(private readonly emit: (event: LoginEvent) => void) {
    this.interaction = {
      signal: this.controller.signal,
      prompt: prompt => this.ask(prompt),
      notify: event => { const shown = loginEvent(event); if (shown) this.emit(shown); },
    };
  }

  get cancelled(): boolean { return this.controller.signal.aborted; }

  private ask(prompt: AuthPrompt): Promise<string> {
    if (this.controller.signal.aborted) return Promise.reject(new Error("Login cancelled"));
    const id = this.nextPrompt++;
    return new Promise((resolve, reject) => {
      const signals = [this.controller.signal, ...(prompt.signal ? [prompt.signal] : [])];
      const close = () => {
        if (!this.prompts.delete(id)) return;
        for (const signal of signals) signal.removeEventListener("abort", close);
        this.emit({ kind: "prompt-closed", prompt: id });
        reject(new Error("Login cancelled"));
      };
      this.prompts.set(id, value => {
        for (const signal of signals) signal.removeEventListener("abort", close);
        resolve(value);
      });
      for (const signal of signals) signal.addEventListener("abort", close, { once: true });
      this.emit({ kind: "prompt", prompt: id, detail: loginPrompt(prompt) });
      if (signals.some(signal => signal.aborted)) close();
    });
  }

  /** The owner's answer; false when the prompt isn't waiting (answered, closed, or never asked). */
  answer(prompt: number, value: string): boolean {
    const resolve = this.prompts.get(prompt);
    if (!resolve) return false;
    this.prompts.delete(prompt);
    resolve(value);
    return true;
  }

  cancel(): void { this.controller.abort(); }
}

/**
 * Runs one sign-in to completion: Pi saves the credential in its auth.json on this host. Resolves once signed in;
 * rejects with a LoginError.
 */
export async function runLogin(input: { runtime: LoginRuntime; provider: string; method: LoginMethodType; session: LoginSession; deviceId: () => string }): Promise<void> {
  const provider = (await loginProviders(input.runtime)).find(entry => entry.id === input.provider);
  if (!provider?.methods.some(method => method.type === input.method)) throw new LoginError("This provider can't sign in that way here.");
  try {
    await input.runtime.login(input.provider, input.method, input.session.interaction, { getDeviceId: input.deviceId });
  } catch (error) {
    const failure = loginFailure(error, input.session.cancelled);
    throw new LoginError(failure.message, failure.cancelled);
  }
}
