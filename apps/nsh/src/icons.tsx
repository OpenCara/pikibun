import { Canvas, Path2D, type ViewStyle } from "nsh";
import { palette } from "./theme";

/**
 * The app's icons: 24×24 outlines in Lucide's style (lucide.dev, ISC license), drawn natively with `Canvas` so they are
 * crisp at any size and take the theme's colors. NSH has no icon font; emoji and text symbols looked different on
 * every platform. A circle is written as two arcs (`M cx+r cy a r r 0 1 1 -2r 0 a r r 0 1 1 2r 0`).
 */
const circle = (cx: number, cy: number, r: number) => `M${cx + r} ${cy}a${r} ${r} 0 1 1 ${-2 * r} 0a${r} ${r} 0 1 1 ${2 * r} 0`;
const rect = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`;
const shield = "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z";

const outlines = {
  plus: "M5 12h14M12 5v14",
  search: `${circle(11, 11, 8)}M21 21l-4.3-4.3`,
  settings: `M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z${circle(12, 12, 3)}`,
  "chevron-left": "M15 18l-6-6 6-6",
  "chevron-right": "M9 18l6-6-6-6",
  "chevron-down": "M6 9l6 6 6-6",
  "chevron-up": "M18 15l-6-6-6 6",
  "arrow-up": "M5 12l7-7 7 7M12 19V5",
  "shield-check": `${shield}M9 12l2 2 4-4`,
  "shield-alert": `${shield}M12 8v4M12 16h.01`,
  copy: `${rect(8, 8, 14, 14, 2)}M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2`,
  "panel-right": `${rect(3, 3, 18, 18, 2)}M15 3v18`,
  "panel-left": `${rect(3, 3, 18, 18, 2)}M9 3v18`,
  info: `${circle(12, 12, 10)}M12 16v-4M12 8h.01`,
  terminal: "M4 17l6-6-6-6M12 19h8",
  monitor: `${rect(2, 3, 20, 14, 2)}M8 21h8M12 17v4`,
  sparkles: "M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0zM20 3v4M22 5h-4",
  zap: "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z",
  eye: `M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0${circle(12, 12, 3)}`,
  alert: "M21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4M12 17h.01",
  users: `M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2${circle(9, 7, 4)}M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75`,
  user: `M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2${circle(12, 7, 4)}`,
  lock: `${rect(3, 11, 18, 11, 2)}M7 11V7a5 5 0 0 1 10 0v4`,
  archive: `${rect(2, 3, 20, 5, 1)}M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4`,
  more: `${circle(12, 12, 1)}${circle(19, 12, 1)}${circle(5, 12, 1)}`,
  check: "M20 6L9 17l-5-5",
  x: "M18 6L6 18M6 6l12 12",
  clock: `${circle(12, 12, 10)}M12 6v6l4 2`,
  "pull-request": `${circle(18, 18, 3)}${circle(6, 6, 3)}M13 6h3a2 2 0 0 1 2 2v7M6 9v12`,
  branch: `M6 3v12${circle(18, 6, 3)}${circle(6, 18, 3)}M18 9a9 9 0 0 1-9 9`,
  message: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  "message-question": `M7.9 20A9 9 0 1 0 4 16.1L2 22zM9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01`,
  "log-out": "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  contrast: `${circle(12, 12, 10)}M12 18a6 6 0 0 0 0-12z`,
  hash: "M4 9h16M4 15h16M10 3L8 21M16 3l-2 18",
  refresh: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5",
  file: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7zM14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8",
  "external-link": "M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  compose: "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.38 2.62a1 1 0 0 1 3 3l-9.01 9.02a2 2 0 0 1-.86.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.86z",
  list: "M3 12h.01M3 18h.01M3 6h.01M8 12h13M8 18h13M8 6h13",
  github: "M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4M9 18c-4.51 2-5-2-7-2",
  globe: `${circle(12, 12, 10)}M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20`,
  folder: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z",
  history: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M12 7v5l4 2",
  undo: "M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11",
  "git-fork": `${circle(12, 18, 3)}${circle(6, 6, 3)}${circle(18, 6, 3)}M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9M12 12v3`,
  link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  server: `${rect(2, 2, 20, 8, 2)}${rect(2, 14, 20, 8, 2)}M6 6h.01M6 18h.01`,
} as const;

/** Icons drawn filled rather than outlined. */
const fills = {
  stop: rect(5, 5, 14, 14, 3),
  dot: circle(12, 12, 5),
} as const;

export type IconName = keyof typeof outlines | keyof typeof fills;

const paths = new Map<string, Path2D>();
function path(name: IconName): Path2D {
  let found = paths.get(name);
  if (!found) {
    found = new Path2D((outlines as Record<string, string>)[name] ?? (fills as Record<string, string>)[name]);
    paths.set(name, found);
  }
  return found;
}

/** An icon, `size` points square, in `color` (the muted text color by default). */
export function Icon(props: { name: IconName; size?: number; color?: string; strokeWidth?: number; style?: ViewStyle }) {
  const size = () => props.size ?? 16;
  return (
    <Canvas accessible={false} style={{ width: size(), height: size(), flexShrink: 0, ...props.style }}
      draw={(cx, area) => {
        const color = props.color ?? palette().muted;
        const scale = Math.min(area.width, area.height) / 24;
        cx.scale(scale, scale);
        if (props.name in fills) {
          cx.fillStyle = color;
          cx.fill(path(props.name));
        } else {
          cx.strokeStyle = color;
          cx.lineWidth = props.strokeWidth ?? 2;
          cx.lineCap = "round";
          cx.lineJoin = "round";
          cx.stroke(path(props.name));
        }
      }} />
  );
}
