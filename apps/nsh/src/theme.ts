import { colorScheme, signal } from "nsh";
import { themes, type ThemeTokens } from "./tokens";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "running";

export type ThemePreference = "system" | "light" | "dark" | "pikibun";

export interface Palette {
  scheme: "light" | "dark";
  background: string;
  sidebar: string;
  surface: string;
  surfaceRaised: string;
  control: string;
  hover: string;
  hoverStrong: string;
  selection: string;
  border: string;
  borderStrong: string;
  text: string;
  muted: string;
  faint: string;
  primary: string;
  onPrimary: string;
  accent: string;
  accentHover: string;
  accentSoft: string;
  onAccent: string;
  userBubble: string;
  onUserBubble: string;
  code: string;
  backdrop: string;
  shadow: string;
  merged: string;
  tones: Record<Tone, { text: string; background: string; border: string }>;
  dots: Record<Tone, string>;
}

function mix(color: string, base: string, percent: number): string {
  const channels = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
  const [a, b] = [channels(color), channels(base)];
  return `#${a.map((value, index) => Math.round(value * percent / 100 + b[index]! * (1 - percent / 100)).toString(16).padStart(2, "0")).join("")}`;
}
const wash = (color: string, percent: number) => `${color}${Math.round(255 * percent / 100).toString(16).padStart(2, "0")}`;

function build({ scheme, colors: c, shadow }: ThemeTokens): Palette {
  const tone = (color: string, percent = 40) => ({ text: color, background: wash(color, 12), border: mix(color, c.border, percent) });
  return {
    scheme,
    background: c.background, sidebar: c["surface-sidebar"], surface: c.surface1, surfaceRaised: c.surface2, control: c.surface3,
    hover: c.interaction, hoverStrong: c["interaction-strong"], selection: c.surface2,
    border: c.border, borderStrong: c["border-accent"],
    text: c.foreground, muted: c["foreground-muted"], faint: c["foreground-extra-muted"],
    primary: c.foreground, onPrimary: c.background,
    accent: c.accent, accentHover: c["accent-hover"], accentSoft: wash(c.accent, 14), onAccent: c["accent-foreground"],
    userBubble: c.surface2, onUserBubble: c.foreground,
    code: c["code-background"], backdrop: "#00000073", shadow, merged: c["status-merged"],
    tones: {
      neutral: { text: c["foreground-muted"], background: c.surface3, border: c.border },
      info: tone(c["status-info"]), success: tone(c["status-success"]), warning: tone(c["status-warning"], 45), danger: tone(c["status-danger"], 45),
      running: tone(c["status-info"]),
    },
    dots: {
      neutral: c["foreground-extra-muted"], info: c["dot-running"], running: c["dot-running"],
      success: c["dot-success"], warning: c["dot-warning"], danger: c["dot-danger"],
    },
  };
}

const light = build(themes.light);
const dark = build(themes.dark);
const pikibun = build(themes.pikibun);

export const themePreference = signal<ThemePreference>("system");

export const palette = (): Palette => (themePreference() === "pikibun" ? pikibun : colorScheme() === "dark" ? dark : light);

export const monospace = "monospace";

export const text = {
  caption: 12,
  small: 13,
  body: 14,
  reading: 15,
  title: 14,
  large: 16,
  heading: 26,
} as const;

export const weight = { light: "300", normal: "400", medium: "500", semibold: "600" } as const;

export const radius = { xsmall: 4, small: 6, medium: 8, large: 12, pill: 999 } as const;

export const control = { xsmall: 28, small: 32, medium: 40, large: 44 } as const;

export const layout = { sidebar: 280, settingsList: 280, content: 720, chat: 820 } as const;
