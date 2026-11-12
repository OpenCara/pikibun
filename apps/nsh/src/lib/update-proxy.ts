// The proxy an update's download goes through, where NSH's fetch wouldn't use it.
//
// NSH's fetch is NSURLSession on macOS, which follows the system's proxy settings but not a shell's variables, and ureq on
// Windows and Linux, which follows the app process's own HTTPS_PROXY, ALL_PROXY and HTTP_PROXY but not the system's
// settings. An app opened from the Dock, the Start menu or a launcher has no shell variables, so a local proxy set in the
// system's settings (Windows, GNOME) or exported by the login shell (`export https_proxy=http://127.0.0.1:7890`) never
// carried the download. The app finds it as the computer's own tools would, and curl downloads through it.
//
// No imports: the root's Node tests run these as they are.

export const PROXY_VARIABLES = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"] as const;

export const WINDOWS_INTERNET_SETTINGS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

const MARKER = "\u001epikibun-proxy ";
const MARK = "\\036pikibun-proxy";

// Run by the login shell (`-ilc`), so its startup files have set what a terminal has. curl's order for an https URL, then
// HTTP_PROXY's, which people set beside it and ureq also reads.
export const SHELL_PROXY_PROBE = `printf '\\n${MARK} %s\\n' "\${https_proxy:-\${HTTPS_PROXY:-\${all_proxy:-\${ALL_PROXY:-\${http_proxy:-\${HTTP_PROXY:-}}}}}}"`;

// GNOME's manual proxy (Settings → Network → Proxy), which sets no variables: its HTTPS, HTTP and SOCKS hosts, in order.
export const GNOME_PROXY_PROBE = [
  "command -v gsettings >/dev/null 2>&1 || exit 0",
  "[ \"$(gsettings get org.gnome.system.proxy mode 2>/dev/null)\" = \"'manual'\" ] || exit 0",
  "for kind in https http socks; do",
  "  host=$(gsettings get org.gnome.system.proxy.$kind host 2>/dev/null)",
  "  port=$(gsettings get org.gnome.system.proxy.$kind port 2>/dev/null)",
  `  printf '${MARK} %s %s %s\\n' "$kind" "$host" "$port"`,
  "done",
].join("\n");

// What curl takes and the shells and cmd pass on as one word: a scheme it knows, then a host and port, credentials allowed,
// with none of cmd's or a shell's special characters.
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

// `reg query` of Internet Settings: ProxyEnable and ProxyServer, which Windows' Settings → Proxy and local proxies (Clash,
// v2rayN) set. ProxyServer is `host:port` for every protocol, or `http=host:port;https=host:port;socks=host:port`.
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
  const web = named.get("https") ?? named.get("http") ?? plain;
  if (web) return proxyUrl(web);
  const socks = named.get("socks");
  return socks ? proxyUrl(socks, "socks4a") : null;
}

export function curlArguments(url: string, proxy: string, output: string): string[] {
  return [
    "--fail", "--location", "--silent", "--show-error", "--proxy", proxy, "--user-agent", "Pikibun-App",
    "--connect-timeout", "30", "--speed-limit", "1024", "--speed-time", "60", "--retry", "2", "--output", output, url,
  ];
}
