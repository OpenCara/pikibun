export const PROXY_VARIABLES = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"] as const;

export const WINDOWS_INTERNET_SETTINGS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

const MARKER = "\u001epikibun-proxy ";
const MARK = "\\036pikibun-proxy";

export const SHELL_PROXY_PROBE = `printf '\\n${MARK} %s\\n' "\${https_proxy:-\${HTTPS_PROXY:-\${all_proxy:-\${ALL_PROXY:-\${http_proxy:-\${HTTP_PROXY:-}}}}}}"`;

export const GNOME_PROXY_PROBE = [
  "command -v gsettings >/dev/null 2>&1 || exit 0",
  "[ \"$(gsettings get org.gnome.system.proxy mode 2>/dev/null)\" = \"'manual'\" ] || exit 0",
  "for kind in https http socks; do",
  "  host=$(gsettings get org.gnome.system.proxy.$kind host 2>/dev/null)",
  "  port=$(gsettings get org.gnome.system.proxy.$kind port 2>/dev/null)",
  `  printf '${MARK} %s %s %s\\n' "$kind" "$host" "$port"`,
  "done",
].join("\n");

const SAFE_PROXY = /^(https?|socks4a?|socks5h?):\/\/[A-Za-z0-9._~\-[\]:@]+$/i;

export function proxyUrl(value: string, scheme = "http"): string | null {
  const text = value.trim().replace(/\/+$/, "");
  if (!text) return null;
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `${scheme}://${text}`;
  return SAFE_PROXY.test(url) ? url : null;
}

const marked = (output: string) => output.split(/\r?\n/).filter(line => line.startsWith(MARKER)).map(line => line.slice(MARKER.length).trim());

export function shellProxy(output: string): string | null {
  const value = marked(output).at(-1);
  return value ? proxyUrl(value) : null;
}

export function gnomeProxy(output: string): string | null {
  for (const line of marked(output)) {
    const [kind, quoted = "", port = ""] = line.split(/\s+/);
    const host = quoted.replace(/^'|'$/g, "");
    const number = Number(port);
    if (!host || !Number.isInteger(number) || number <= 0 || number > 65_535) continue;
    const url = proxyUrl(`${host.includes(":") ? `[${host}]` : host}:${number}`, kind === "socks" ? "socks5h" : "http");
    if (url) return url;
  }
  return null;
}

export function windowsProxy(output: string): string | null {
  const value = (name: string) => new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*?)\\s*$`, "mi").exec(output)?.[1];
  const enabled = value("ProxyEnable");
  if (!enabled || !Number(enabled)) return null;
  const server = value("ProxyServer");
  if (!server) return null;
  const named = new Map<string, string>();
  let plain: string | undefined;
  for (const entry of server.split(";").map(part => part.trim()).filter(Boolean)) {
    const pair = /^([a-z]+)=(.+)$/i.exec(entry);
    if (pair) named.set(pair[1]!.toLowerCase(), pair[2]!);
    else plain ??= entry;
  }
  const candidates: [string | undefined, string][] = [[named.get("https"), "http"], [named.get("http"), "http"], [plain, "http"], [named.get("socks"), "socks4a"]];
  for (const [value, scheme] of candidates) {
    const url = value ? proxyUrl(value, scheme) : null;
    if (url) return url;
  }
  return null;
}

export function shownProxy(proxy: string): string {
  return proxy.replace(/\/\/[^@/]*@/, "//…@");
}

export function curlArguments(url: string, proxy: string, output: string): string[] {
  return [
    "--fail", "--location", "--silent", "--show-error", "--proxy", proxy, "--user-agent", "Pikibun-App",
    "--connect-timeout", "30", "--speed-limit", "1024", "--speed-time", "60", "--retry", "2", "--output", output, url,
  ];
}
