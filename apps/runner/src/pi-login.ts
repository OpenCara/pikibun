import { homedir } from "node:os";
import type { AuthEvent, AuthInteraction, AuthPrompt, LoginOptions } from "@earendil-works/pi-ai";
import type { LoginEvent, LoginMethodType, LoginPrompt, LoginProvider } from "./app-host-protocol.js";

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

export async function piLogin(): Promise<{ runtime: LoginRuntime; deviceId: () => string }> {
  const { ModelRuntime, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  return { runtime, deviceId: () => SettingsManager.create(homedir()).getOrCreateDeviceId() };
}

export async function loginProviders(runtime: LoginRuntime): Promise<LoginProvider[]> {
  const signedIn = new Set((await runtime.listCredentials()).map(item => item.providerId));
  const providers: LoginProvider[] = [];
  for (const provider of runtime.getProviders()) {
    const name = label(provider.name);
    if (!PROVIDER_ID.test(provider.id) || !name) continue;
    const methods: LoginProvider["methods"] = [];
    const oauth = provider.auth.oauth;
    if (oauth) methods.push({ type: "oauth", name: label(oauth.name) ?? name, ...(oauth.isSubscription ? { subscription: true } : {}) });
    const apiKey = provider.auth.apiKey;
    if (apiKey?.login) methods.push({ type: "api_key", name: label(apiKey.name) ?? `${name} API key` });
    if (methods.length) providers.push({ id: provider.id, name, signedIn: signedIn.has(provider.id), methods });
    if (providers.length >= MAX_PROVIDERS) break;
  }
  return providers;
}

const link = (value: unknown): string | undefined => {
  const url = typeof value === "string" && value.length <= 8192 ? URL.parse(value) : null;
  return url && (url.protocol === "https:" || (url.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname))) ? url.href : undefined;
};

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

export function loginFailure(error: unknown, cancelled: boolean): { cancelled: boolean; message: string } {
  const raw = error instanceof Error ? error.message : "";
  if (cancelled || /^login cancelled$/i.test(raw.trim())) return { cancelled: true, message: "Sign-in cancelled." };
  const message = raw.replace(/[A-Za-z0-9+/_.=-]{32,}/g, "…").replace(/\{[\s\S]*\}/g, "{…}").replace(/\s+/g, " ").trim().slice(0, 300);
  return { cancelled: false, message: message ? `Sign-in failed: ${message}` : "Sign-in failed." };
}

export class LoginError extends Error {
  constructor(message: string, readonly cancelled = false) { super(message); }
}

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

  answer(prompt: number, value: string): boolean {
    const resolve = this.prompts.get(prompt);
    if (!resolve) return false;
    this.prompts.delete(prompt);
    resolve(value);
    return true;
  }

  cancel(): void { this.controller.abort(); }
}

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
