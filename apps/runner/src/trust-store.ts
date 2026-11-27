import { readFile } from "node:fs/promises";
import { getCACertificates, rootCertificates } from "node:tls";
import { interceptionAuthority } from "./interception-ca.js";

export const CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

export const CA_BUNDLE_VARIABLES = ["SSL_CERT_FILE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"] as const;

type CertificateSource = (type: "system" | "bundled" | "extra") => string[];

export function trustedCertificates(source: CertificateSource = getCACertificates, platform: NodeJS.Platform = process.platform): string {
  const read = (type: "system" | "bundled" | "extra"): string[] => {
    try {
      return source(type).filter(certificate => typeof certificate === "string" && certificate.includes("-----BEGIN CERTIFICATE-----"));
    } catch {
      return [];
    }
  };
  const system = read("system");
  const base = platform === "darwin" ? [...read("bundled"), ...system] : system.length ? system : read("bundled");
  const certificates = [...new Set([...(base.length ? base : rootCertificates), ...read("extra")].map(certificate => certificate.trim()))];
  return `${certificates.join("\n")}\n`;
}

const CA_FILE_BYTES = 4 * 1024 * 1024;
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

export async function hostSessionCertificates(environment: Readonly<Record<string, string | undefined>>): Promise<string> {
  const files = [...new Set(CA_BUNDLE_VARIABLES.map(name => environment[name]).filter((path): path is string => !!path))];
  const extra: string[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text.length <= CA_FILE_BYTES) extra.push(...text.match(PEM_CERTIFICATE) ?? []);
  }
  const base = sandboxCertificates();
  const added = [...new Set(extra.map(certificate => certificate.trim()))].filter(certificate => !base.includes(certificate));
  return added.length ? `${base}${added.join("\n")}\n` : base;
}

export function proxyConfigured(environment: Readonly<Record<string, string | undefined>>): boolean {
  return ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"].some(name => !!environment[name]);
}

export function sandboxCertificates(): string {
  return `${trustedCertificates()}${interceptionAuthority().certificate}`;
}
