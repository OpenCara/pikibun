import { colorScheme } from "nsh";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "running";

export interface Palette {
  scheme: "light" | "dark";
  /** The main area: the conversation, settings pages. */
  background: string;
  /** The sidebar and other chrome around the main area. */
  sidebar: string;
  /** Cards, inputs and the chat box. */
  surface: string;
  /** Something raised on a surface: a code block, a pressed or hovered row. */
  surfaceRaised: string;
  hover: string;
  border: string;
  /** The border of inputs and of what is focused or chosen. */
  borderStrong: string;
  text: string;
  muted: string;
  /** Less than muted: timestamps, placeholders' companions, disabled marks. */
  faint: string;
  primary: string;
  onPrimary: string;
  /** Pikibun's lavender: what is chosen, focused, or the app's own mark. */
  accent: string;
  accentSoft: string;
  onAccent: string;
  selection: string;
  userBubble: string;
  onUserBubble: string;
  code: string;
  backdrop: string;
  tones: Record<Tone, { text: string; background: string; border: string }>;
}

const light: Palette = {
  scheme: "light",
  background: "#ffffff",
  sidebar: "#f7f7f8",
  surface: "#ffffff",
  surfaceRaised: "#f4f4f6",
  hover: "#ededf0",
  border: "#e7e7eb",
  borderStrong: "#d2d2d9",
  text: "#111114",
  muted: "#61616b",
  faint: "#9a9aa4",
  primary: "#18181b",
  onPrimary: "#ffffff",
  accent: "#6d4fe0",
  accentSoft: "#f0ebff",
  onAccent: "#ffffff",
  selection: "#e9e9ee",
  userBubble: "#f1f1f4",
  onUserBubble: "#111114",
  code: "#f6f6f8",
  backdrop: "#0000004d",
  tones: {
    neutral: { text: "#52525b", background: "#f1f1f4", border: "#e4e4e8" },
    info: { text: "#1d4ed8", background: "#eef3ff", border: "#d3e0fd" },
    success: { text: "#15803d", background: "#ecf8f0", border: "#c9ecd5" },
    warning: { text: "#a15c07", background: "#fdf6e7", border: "#f6e2b6" },
    danger: { text: "#c0262d", background: "#fdf0f0", border: "#f6d2d2" },
    running: { text: "#6d4fe0", background: "#f3efff", border: "#e1d8fd" },
  },
};

const dark: Palette = {
  scheme: "dark",
  background: "#111113",
  sidebar: "#0b0b0d",
  surface: "#18181b",
  surfaceRaised: "#1f1f23",
  hover: "#232328",
  border: "#26262b",
  borderStrong: "#36363d",
  text: "#ececef",
  muted: "#a1a1ab",
  faint: "#6c6c76",
  primary: "#ececef",
  onPrimary: "#111113",
  accent: "#a48bff",
  accentSoft: "#251f3d",
  onAccent: "#111113",
  selection: "#232329",
  userBubble: "#232328",
  onUserBubble: "#ececef",
  code: "#17171a",
  backdrop: "#00000099",
  tones: {
    neutral: { text: "#c4c4cc", background: "#232328", border: "#2e2e34" },
    info: { text: "#93b4fb", background: "#151d30", border: "#22304f" },
    success: { text: "#7ad79a", background: "#11231a", border: "#1b3a27" },
    warning: { text: "#f2be63", background: "#2a210f", border: "#44351a" },
    danger: { text: "#f69a9a", background: "#2c1416", border: "#4a2124" },
    running: { text: "#b9a6ff", background: "#1f1933", border: "#332a55" },
  },
};

/** The palette of the appearance shown (reactive: read it in bindings). */
export const palette = (): Palette => (colorScheme() === "dark" ? dark : light);

export const monospace = "monospace";

/** Type sizes, in points. */
export const text = {
  caption: 12,
  small: 13,
  body: 14,
  /** Messages and inputs, where reading matters most. */
  reading: 15,
  title: 15,
  heading: 22,
} as const;

export const radius = { small: 6, medium: 8, large: 12, xlarge: 16, pill: 999 } as const;
