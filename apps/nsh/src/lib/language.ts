import { signal, Storage } from "nsh";
import { addTranslations, setLocale } from "nsh/i18n";
import translations from "../../locales/app.json";

export const languages = [
  { value: "en", label: "English" },
  { value: "zh", label: "简体中文" },
  { value: "zh-Hant", label: "繁體中文" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
] as const;

export type Language = (typeof languages)[number]["value"];
export type LanguagePreference = Language | "system";

const KEY = "pikibun.language";
const TRADITIONAL_REGIONS = ["zh-TW", "zh-HK", "zh-MO"];

export const languagePreference = signal<LanguagePreference>("system");

export const isLanguage = (value: unknown): value is Language => languages.some(language => language.value === value);

export function traditionalAliases(source: Record<string, unknown>): Record<string, Record<string, string>> {
  const texts: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const text = value && typeof value === "object" ? (value as Record<string, unknown>)["zh-Hant"] : undefined;
    if (typeof text === "string") texts[key] = text;
  }
  return Object.fromEntries(TRADITIONAL_REGIONS.map(region => [region, texts]));
}

let aliased = false;
function addAliases() {
  if (aliased) return;
  aliased = true;
  addTranslations(traditionalAliases(translations));
}

function show(value: LanguagePreference) {
  languagePreference.set(value);
  setLocale(value === "system" ? null : value);
}

export async function applyStoredLanguage(): Promise<void> {
  addAliases();
  const stored = await Storage.getItem(KEY).catch(() => null);
  if (isLanguage(stored)) show(stored);
}

export function chooseLanguage(value: LanguagePreference): void {
  show(value);
  (value === "system" ? Storage.removeItem(KEY) : Storage.setItem(KEY, value)).catch(() => undefined);
}
