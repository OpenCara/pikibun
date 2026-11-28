import { setColorScheme, Storage, View } from "nsh";
import { t } from "nsh/i18n";
import { Select } from "../form";
import { chooseLanguage, languagePreference, languages, type LanguagePreference } from "../lib/language";
import { themePreference, type ThemePreference } from "../theme";
import { Row, Section, Segmented } from "../ui";
import { SectionPage, type SectionProps } from "./parts";

const KEY = "pikibun.appearance";

const isPreference = (value: unknown): value is Exclude<ThemePreference, "system"> => value === "light" || value === "dark" || value === "pikibun";

function show(value: ThemePreference) {
  themePreference.set(value);
  setColorScheme(value === "pikibun" ? "dark" : value);
}

export async function applyStoredAppearance(): Promise<void> {
  const stored = await Storage.getItem(KEY).catch(() => null);
  if (isPreference(stored)) show(stored);
}

export function Appearance(_props: SectionProps) {
  function choose(value: ThemePreference) {
    show(value);
    (value === "system" ? Storage.removeItem(KEY) : Storage.setItem(KEY, value)).catch(() => undefined);
  }
  const languageOptions = (): { value: LanguagePreference; label: string }[] => [
    { value: "system", label: t("appearance.system") },
    ...languages.map(language => ({ value: language.value, label: language.label })),
  ];
  return (
    <SectionPage testID="settings-appearance">
      <Section title={t("appearance.theme")}>
        <Row title={t("appearance.color_theme")} hint={t("appearance.color_theme_hint")}
          trailing={<Segmented testID="appearance-scheme" value={themePreference()} onChange={choose}
            options={[{ value: "system", label: t("appearance.system") }, { value: "light", label: t("appearance.light") },
              { value: "dark", label: t("appearance.dark") }, { value: "pikibun", label: "Pikibun" }]} />} />
      </Section>
      <Section title={t("appearance.language")}>
        <Row title={t("appearance.display_language")} hint={t("appearance.display_language_hint")}
          trailing={<View style={{ width: 160 }}>
            <Select<LanguagePreference> testID="appearance-language" compact label={t("appearance.display_language")}
              value={languagePreference()} options={languageOptions()} onChange={chooseLanguage} />
          </View>} />
      </Section>
    </SectionPage>
  );
}
