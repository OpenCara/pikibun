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

export function sandboxCertificates(): string {
  return `${trustedCertificates()}${interceptionAuthority().certificate}`;
}
