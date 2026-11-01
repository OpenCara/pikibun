import { useId, type ReactNode } from "react";

export type IconName =
  | "plus" | "settings" | "more" | "chevron-right" | "chevron-down" | "chevron-up" | "chevron-left" | "x" | "check" | "copy"
  | "folder" | "file" | "message" | "terminal" | "tool" | "send" | "panel-right" | "menu" | "info" | "alert" | "shield"
  | "server" | "users" | "user" | "palette" | "sun" | "moon" | "sparkle" | "monitor" | "logout" | "archive"
  | "git-branch" | "git-pull-request" | "github" | "lock" | "globe" | "refresh" | "search" | "eye" | "trash" | "external" | "history" | "pencil" | "link" | "stop" | "clock" | "image" | "arrow-down";

const paths: Record<Exclude<IconName, "github">, ReactNode> = {
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  settings: <><path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.6a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.6a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2Z" /><circle cx="12" cy="12" r="3" /></>,
  pencil: <><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" /></>,
  more: <><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></>,
  "chevron-right": <path d="m9 18 6-6-6-6" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  "chevron-up": <path d="m18 15-6-6-6 6" />,
  "chevron-left": <path d="m15 18-6-6 6-6" />,
  x: <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
  copy: <><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M4 16V5a2 2 0 0 1 2-2h11" /></>,
  folder: <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
  file: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></>,
  message: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />,
  terminal: <><path d="m4 17 6-6-6-6" /><path d="M12 19h8" /></>,
  tool: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9Z" />,
  send: <><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />,
  "panel-right": <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /></>,
  menu: <><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></>,
  info: <><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></>,
  alert: <><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
  shield: <path d="M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1Z" />,
  server: <><rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" /><path d="M6 6h.01" /><path d="M6 18h.01" /></>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9" /><path d="M16 3.1a4 4 0 0 1 0 7.8" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M20 21a8 8 0 0 0-16 0" /></>,
  palette: <><circle cx="13.5" cy="6.5" r=".5" /><circle cx="17.5" cy="10.5" r=".5" /><circle cx="8.5" cy="7.5" r=".5" /><circle cx="6.5" cy="12.5" r=".5" /><path d="M12 2a10 10 0 0 0 0 20 1.7 1.7 0 0 0 1.7-1.7c0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1a1.7 1.7 0 0 1 1.6-1.7H16a5.6 5.6 0 0 0 5.6-5.6C21.6 6 17.3 2 12 2Z" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.9 4.9 1.4 1.4" /><path d="m17.7 17.7 1.4 1.4" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.3 17.7-1.4 1.4" /><path d="m19.1 4.9-1.4 1.4" /></>,
  moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  sparkle: <path d="M9.9 15.5a2 2 0 0 0-1.4-1.4l-6.1-1.6a.5.5 0 0 1 0-1l6.1-1.6a2 2 0 0 0 1.4-1.4l1.6-6.1a.5.5 0 0 1 1 0l1.6 6.1a2 2 0 0 0 1.4 1.4l6.1 1.6a.5.5 0 0 1 0 1l-6.1 1.6a2 2 0 0 0-1.4 1.4l-1.6 6.1a.5.5 0 0 1-1 0Z" />,
  monitor: <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>,
  archive: <><rect x="2" y="3" width="20" height="5" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></>,
  "git-branch": <><path d="M6 3v12" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></>,
  "git-pull-request": <><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /><path d="M6 9v12" /></>,
  lock: <><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>,
  globe: <><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" /></>,
  refresh: <><path d="M3 12a9 9 0 0 1 9-9 9.8 9.8 0 0 1 6.7 2.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.8 9.8 0 0 1-6.7-2.7L3 16" /><path d="M8 16H3v5" /></>,
  search: <><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>,
  eye: <><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>,
  trash: <><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>,
  external: <><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>,
  history: <><path d="M3 12a9 9 0 1 0 9-9 9.8 9.8 0 0 0-6.7 2.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></>,
  clock: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" /></>,
  "arrow-down": <><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></>,
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  if (name === "github") return <GitHubMark size={size} />;
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

const LEAF = "M0 0C-1.6-.4-2.6-1.6-4.2-2.9-6.6-4.8-10.6-4.6-11.8-2.2-12.8-.2-11 2.6-8.2 3.2-5.8 3.7-3 1.6-1.6.6-1 .2-.5.05 0 0Z";
const VEINS = "M-1 .05C-4-.4-7.6-.6-11.2-1.4M-5-.45-7-2.9M-5-.45-6.8 1.9M-8.2-.85-9.9-3.1M-8.2-.85-9.6 1.6";
const LEFT_EAR = "translate(14.7 16.6) rotate(33) scale(1.15)";
const RIGHT_EAR = "translate(17.3 16.6) scale(-1 1) rotate(33) scale(1.15)";

/**
 * The Pikibun mark: Pikibun, the maple-seed-eared creature, on its night sky (the same drawing as public/favicon.svg).
 * Gradient ids are per instance, since a page can show several marks and SVG ids are document-wide.
 */
export function Logo({ size = 24 }: { size?: number }) {
  const id = useId().replace(/[^\w-]/g, "");
  const [sky, ear, body, glow] = ["sky", "ear", "body", "glow"].map(name => `${id}${name}`);
  const shape = <>
    <path d={LEAF} transform={LEFT_EAR} /><path d={LEAF} transform={RIGHT_EAR} />
    <ellipse cx="11.1" cy="22.3" rx="1.45" ry=".75" transform="rotate(-25 11.1 22.3)" />
    <ellipse cx="20.9" cy="22.3" rx="1.45" ry=".75" transform="rotate(25 20.9 22.3)" />
    <ellipse cx="15" cy="28.5" rx=".85" ry="1.25" /><ellipse cx="17" cy="28.5" rx=".85" ry="1.25" />
    <ellipse cx="16" cy="21.6" rx="4.9" ry="5.5" />
  </>;
  return <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <defs>
      <radialGradient id={sky} cx="50%" cy="50%" r="72%"><stop offset="0" stopColor="#2b1454" /><stop offset="1" stopColor="#110530" /></radialGradient>
      <linearGradient id={ear} x1="0" y1=".5" x2="1" y2=".5"><stop offset="0" stopColor="#fdf0c9" /><stop offset=".5" stopColor="#e2d2f5" /><stop offset=".85" stopColor="#bba6ee" /><stop offset="1" stopColor="#f2e2cb" /></linearGradient>
      <radialGradient id={body} cx="50%" cy="74%" r="70%"><stop offset="0" stopColor="#fdf1d6" /><stop offset=".45" stopColor="#f4e0cd" /><stop offset="1" stopColor="#b5a3f0" /></radialGradient>
      <filter id={glow} x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation=".8" /></filter>
    </defs>
    <rect width="32" height="32" rx="9" fill={`url(#${sky})`} />
    <g transform="translate(0 -1.4)">
      <g fill="#fde9c4" opacity=".34" filter={`url(#${glow})`}>{shape}</g>
      <g stroke="#3d1e45" strokeWidth=".5" strokeLinejoin="round">
        <path d={LEAF} transform={LEFT_EAR} fill={`url(#${ear})`} /><path d={LEAF} transform={RIGHT_EAR} fill={`url(#${ear})`} />
        <ellipse cx="11.1" cy="22.3" rx="1.45" ry=".75" transform="rotate(-25 11.1 22.3)" fill="#ebe0f7" />
        <ellipse cx="20.9" cy="22.3" rx="1.45" ry=".75" transform="rotate(25 20.9 22.3)" fill="#ebe0f7" />
        <path d="M15.1 26.8v.6M16.9 26.8v.6" fill="none" stroke="#f4e0cd" strokeWidth=".6" />
        <ellipse cx="15" cy="28.5" rx=".85" ry="1.25" fill="#8a64bf" /><ellipse cx="17" cy="28.5" rx=".85" ry="1.25" fill="#8a64bf" />
        <ellipse cx="16" cy="21.6" rx="4.9" ry="5.5" fill={`url(#${body})`} />
      </g>
      <g fill="none" stroke="#a387d8" strokeWidth=".3" strokeLinecap="round" opacity=".85">
        <path d={VEINS} transform={LEFT_EAR} /><path d={VEINS} transform={RIGHT_EAR} />
      </g>
      <circle cx="14.25" cy="20.2" r=".85" fill="#171412" /><circle cx="17.75" cy="20.2" r=".85" fill="#171412" />
      <circle cx="14.5" cy="19.92" r=".27" fill="#fff" /><circle cx="18" cy="19.92" r=".27" fill="#fff" />
      <path d="M15.47 20.85h1.06L16 21.55Z" fill="#e0725f" />
    </g>
  </svg>;
}

export function GitHubMark({ size = 16 }: { size?: number }) {
  return <svg className="icon" width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" /></svg>;
}
