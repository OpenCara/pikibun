import { colorScheme, signal } from "nsh";
import { themes, type ThemeTokens } from "./tokens";

// Pikibun's design system ("modelled on Paseo: minimal, spacious, quiet"), first drawn for the React web client: its
// three themes (tokens.ts), under the names this app's kit reads. Hierarchy comes from weight and color, not size; one accent CTA per surface.

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "running";

/** "pikibun" is the night theme in the character's colors: lavender ears, cream belly, night sky. */
export type ThemePreference = "system" | "light" | "dark" | "pikibun";

export interface Palette {
  scheme: "light" | "dark";
  /** The main area: the conversation, settings pages. (--background) */
  background: string;
  /** The sidebar and other chrome around the main area. (--surface-sidebar) */
  sidebar: string;
  /** Cards, inputs, popovers and the chat box. (--surface1) */
  surface: string;
  /** Something raised on a surface: a user's bubble, a chosen nav item, a segmented control's track. (--surface2) */
  surfaceRaised: string;
  /** A secondary button, a badge, inline code, a chosen segment. (--surface3) */
  control: string;
  /** Under the pointer: a row, a ghost button. (--interaction) */
  hover: string;
  /** Under the pointer on a filled control, and a menu's chosen item. (--interaction-strong) */
  hoverStrong: string;
  /** What is chosen in a list: the open session, the current settings section. (--surface2) */
  selection: string;
  border: string;
  /** Outline buttons, inputs under the pointer, the chat box while focused. (--border-accent) */
  borderStrong: string;
  text: string;
  muted: string;
  /** Less than muted: timestamps, placeholders' companions, disabled marks. (--foreground-extra-muted) */
  faint: string;
  /** Tooltips: the reverse of the page. */
  primary: string;
  onPrimary: string;
  /** The one call to action per surface: Approve, Send, Start session. (--accent) */
  accent: string;
  accentHover: string;
  accentSoft: string;
  onAccent: string;
  userBubble: string;
  onUserBubble: string;
  code: string;
  backdrop: string;
  shadow: string;
  /** A pull request that was merged. (--status-merged) */
  merged: string;
  /** A status's own words and its alert's frame: `text` its color, `background` a 12% wash, `border` its alert's border. */
  tones: Record<Tone, { text: string; background: string; border: string }>;
  /** A session's status dot (--dot-*): brighter than the words, as it is small. */
  dots: Record<Tone, string>;
}

/** `color` over `base` at `percent`, as CSS's `color-mix(in srgb, color percent%, base)` mixes two opaque colors. */
function mix(color: string, base: string, percent: number): string {
  const channels = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
  const [a, b] = [channels(color), channels(base)];
  return `#${a.map((value, index) => Math.round(value * percent / 100 + b[index]! * (1 - percent / 100)).toString(16).padStart(2, "0")).join("")}`;
}
/** `color` at `percent` opacity, as #rrggbbaa. */
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
      // The web app shows a running status in its info color.
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

/** The theme this device chose (settings/Appearance.tsx sets it); "system" follows the platform's appearance. */
export const themePreference = signal<ThemePreference>("system");

/** The palette of the appearance shown (reactive: read it in bindings). */
export const palette = (): Palette => (themePreference() === "pikibun" ? pikibun : colorScheme() === "dark" ? dark : light);

export const monospace = "monospace";

/** Type sizes, in points (--font-*). */
export const text = {
  caption: 12,
  small: 13,
  body: 14,
  /** Messages and inputs, where reading matters most. */
  reading: 15,
  /** A page header's title: the body's size, light (.screen-title). */
  title: 14,
  large: 16,
  /** The home's and sign-in's one big line, light (.new-session-title, .welcome h1). */
  heading: 26,
} as const;

/** Weights (--weight-*): titles are light or medium, never bold; emphasis comes from color. */
export const weight = { light: "300", normal: "400", medium: "500", semibold: "600" } as const;

/** Corner radii (--radius-*): `small` for small controls and menu items, `medium` for buttons and inputs, `large` for cards. */
export const radius = { xsmall: 4, small: 6, medium: 8, large: 12, pill: 999 } as const;

/** Control heights (--control-*). */
export const control = { xsmall: 28, small: 32, medium: 40, large: 44 } as const;

/** The sidebar's width and the readable columns (--sidebar-width, --content-width, --chat-width). */
export const layout = { sidebar: 280, settingsList: 280, content: 720, chat: 820 } as const;
