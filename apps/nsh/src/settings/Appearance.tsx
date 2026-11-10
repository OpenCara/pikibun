import { setColorScheme, Storage } from "nsh";
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
  return (
    <SectionPage testID="settings-appearance">
      <Section title="Theme">
        <Row title="Color theme" hint="On this device. System follows its light or dark appearance."
          trailing={<Segmented testID="appearance-scheme" value={themePreference()} onChange={choose}
            options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "pikibun", label: "Pikibun" }]} />} />
      </Section>
    </SectionPage>
  );
}
