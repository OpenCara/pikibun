// The web app's theme tokens (apps/web/src/styles.css, @layer tokens), under the CSS custom properties' own names, so
// the two clients look alike: theme.ts builds this app's palettes from them, and tests/nsh-theme.test.ts fails when a
// value here differs from the stylesheet's. Change a color there, and here. A translucent `rgb(r g b / a%)` is written
// as #rrggbbaa; the shadows are one layer (NSH draws a single box shadow), so they are this app's own.

export type ThemeName = "light" | "dark" | "pikibun";

export const colorTokens = [
  "background", "surface-sidebar", "surface1", "surface2", "surface3", "interaction", "interaction-strong", "border", "border-accent",
  "foreground", "foreground-muted", "foreground-extra-muted", "accent", "accent-hover", "accent-foreground",
  "status-success", "status-warning", "status-danger", "status-info", "status-merged",
  "dot-success", "dot-warning", "dot-danger", "dot-running", "code-background",
] as const;

export type ColorToken = (typeof colorTokens)[number];

export interface ThemeTokens {
  scheme: "light" | "dark";
  colors: Record<ColorToken, string>;
  /** This app's single-layer stand-in for --shadow. */
  shadow: string;
}

export const themes: Record<ThemeName, ThemeTokens> = {
  light: {
    scheme: "light",
    colors: {
      "background": "#ffffff", "surface-sidebar": "#f7f7f6", "surface1": "#ffffff", "surface2": "#f1f1f0", "surface3": "#e8e8e6",
      "interaction": "#0000000d", "interaction-strong": "#00000014", "border": "#e6e6e4", "border-accent": "#d4d4d1",
      "foreground": "#1b1b1a", "foreground-muted": "#6f6f6b", "foreground-extra-muted": "#a3a39f",
      "accent": "#c4541f", "accent-hover": "#ad4718", "accent-foreground": "#ffffff",
      "status-success": "#2f8a5b", "status-warning": "#a8700e", "status-danger": "#c8463b", "status-info": "#3a74b8", "status-merged": "#8250df",
      "dot-success": "#2fb36a", "dot-warning": "#e0a01b", "dot-danger": "#e5574a", "dot-running": "#3b8cf0", "code-background": "#f6f6f5",
    },
    shadow: "0 8px 28px rgba(0, 0, 0, 0.14)",
  },
  dark: {
    scheme: "dark",
    colors: {
      "background": "#161616", "surface-sidebar": "#1c1c1c", "surface1": "#1c1c1c", "surface2": "#232323", "surface3": "#2c2c2c",
      "interaction": "#ffffff0d", "interaction-strong": "#ffffff17", "border": "#2a2a2a", "border-accent": "#3a3a3a",
      "foreground": "#ececec", "foreground-muted": "#9a9a9a", "foreground-extra-muted": "#6a6a6a",
      "accent": "#e2733f", "accent-hover": "#ec8656", "accent-foreground": "#1a0e08",
      "status-success": "#6cc391", "status-warning": "#e2b25a", "status-danger": "#f0877d", "status-info": "#7fb0e6", "status-merged": "#b79cf5",
      "dot-success": "#3fd17f", "dot-warning": "#f2b438", "dot-danger": "#ff6b5e", "dot-running": "#5aa4ff", "code-background": "#1f1f1f",
    },
    shadow: "0 12px 36px rgba(0, 0, 0, 0.6)",
  },
  pikibun: {
    scheme: "dark",
    colors: {
      "background": "#110530", "surface-sidebar": "#160937", "surface1": "#190c3b", "surface2": "#221447", "surface3": "#2c1c55",
      "interaction": "#bfaaee12", "interaction-strong": "#bfaaee21", "border": "#2b1a52", "border-accent": "#40296e",
      "foreground": "#f7ebd3", "foreground-muted": "#b9abd8", "foreground-extra-muted": "#7d6ca8",
      "accent": "#bfaaee", "accent-hover": "#d3c4f7", "accent-foreground": "#170a36",
      "status-success": "#8bd7a9", "status-warning": "#f3cf7f", "status-danger": "#f2937f", "status-info": "#a0b9f6", "status-merged": "#d7aaff",
      "dot-success": "#4fd98e", "dot-warning": "#f7c75a", "dot-danger": "#ff7a66", "dot-running": "#8fa6ff", "code-background": "#180a38",
    },
    shadow: "0 12px 36px rgba(4, 0, 18, 0.7)",
  },
};
