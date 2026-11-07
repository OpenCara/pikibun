import { setColorScheme, signal, Storage } from "nsh";
import { Card, Segmented, Small } from "../ui";
import { Heading } from "./Profile";
import { SectionPage, type SectionProps } from "./parts";

type Scheme = "system" | "light" | "dark";
const KEY = "pikibun.appearance";

/** The appearance this device chose, applied at start. */
export async function applyStoredAppearance(): Promise<void> {
  const stored = await Storage.getItem(KEY).catch(() => null);
  if (stored === "light" || stored === "dark") setColorScheme(stored);
}

export function Appearance(_props: SectionProps) {
  const scheme = signal<Scheme>("system");
  Storage.getItem(KEY).then(stored => { if (stored === "light" || stored === "dark") scheme.set(stored); }, () => undefined);
  function choose(value: Scheme) {
    scheme.set(value);
    setColorScheme(value);
    (value === "system" ? Storage.removeItem(KEY) : Storage.setItem(KEY, value)).catch(() => undefined);
  }
  return (
    <SectionPage testID="settings-appearance">
      <Heading>Appearance</Heading>
      <Card>
        <Segmented testID="appearance-scheme" value={scheme()} onChange={choose}
          options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        <Small>On this device. System follows its light or dark appearance.</Small>
      </Card>
    </SectionPage>
  );
}
