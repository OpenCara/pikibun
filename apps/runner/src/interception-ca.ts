import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { createSecureContext, type SecureContext } from "node:tls";
import { credentialedApiHosts } from "../../../packages/shared/src/network.js";

const CA_LIFETIME_MS = 10 * 365 * 24 * 3600_000;
const LEAF_LIFETIME_MS = 7 * 24 * 3600_000;
const LEAF_RENEW_MS = 24 * 3600_000;
const BACKDATE_MS = 3600_000;

function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let value = size; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}
const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts);
const set = (...parts: Buffer[]) => tlv(0x31, ...parts);
const octets = (value: Buffer) => tlv(0x04, value);
const bits = (value: Buffer, unused = 0) => tlv(0x03, Buffer.from([unused]), value);
const utf8 = (value: string) => tlv(0x0c, Buffer.from(value, "utf8"));
const TRUE = Buffer.from([0x01, 0x01, 0xff]);
const explicit = (n: number, ...parts: Buffer[]) => tlv(0xa0 + n, ...parts);

function oid(value: string): Buffer {
  const [first, second, ...rest] = value.split(".").map(Number) as [number, number, ...number[]];
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const chunk: number[] = [arc & 0x7f];
    for (let value = Math.floor(arc / 128); value > 0; value = Math.floor(value / 128)) chunk.unshift(0x80 | (value & 0x7f));
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}
function integer(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  const trimmed = value.subarray(start);
  return tlv(0x02, trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}
function time(at: Date): Buffer {
  const iso = at.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return at.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
}
function name(commonName: string): Buffer {
  return sequence(set(sequence(oid("2.5.4.10"), utf8("Pikibun"))), set(sequence(oid("2.5.4.3"), utf8(commonName))));
}
function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(oid(id), ...(critical ? [TRUE] : []), octets(value));
}
const dnsName = (host: string) => tlv(0x82, Buffer.from(host, "ascii"));

const ECDSA_SHA256 = sequence(oid("1.2.840.10045.4.3.2"));

function subjectPublicKeyInfo(key: KeyObject): Buffer {
  return key.export({ type: "spki", format: "der" });
}
function keyIdentifier(spki: Buffer): Buffer {
  return createHash("sha1").update(spki.subarray(spki.length - 65)).digest();
}

interface Issued { pem: string; der: Buffer }

function certificate(input: { serial: Buffer; issuer: string; subject: string; notBefore: Date; notAfter: Date; publicKey: KeyObject;
  extensions: Buffer[]; signer: KeyObject }): Issued {
  const tbs = sequence(
    explicit(0, tlv(0x02, Buffer.from([2]))),
    integer(input.serial),
    ECDSA_SHA256,
    name(input.issuer),
    sequence(time(input.notBefore), time(input.notAfter)),
    name(input.subject),
    subjectPublicKeyInfo(input.publicKey),
    explicit(3, sequence(...input.extensions)),
  );
  const der = sequence(tbs, ECDSA_SHA256, bits(sign("sha256", tbs, input.signer)));
  const base64 = der.toString("base64").replace(/.{1,64}/g, line => `${line}\n`);
  return { der, pem: `-----BEGIN CERTIFICATE-----\n${base64}-----END CERTIFICATE-----\n` };
}

function serial(): Buffer {
  const value = randomBytes(16);
  value[0] = (value[0]! & 0x7f) | 0x01;
  return value;
}

export class InterceptionAuthority {
  readonly certificate: string;
  readonly hosts: readonly string[];
  readonly #key: KeyObject;
  readonly #keyId: Buffer;
  readonly #subject: string;
  readonly #leaves = new Map<string, { context: SecureContext; renewAt: number; certificate: string }>();

  constructor(hosts: readonly string[] = credentialedApiHosts, now = new Date()) {
    if (!hosts.length) throw new Error("A credentialed API host is required");
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    this.#key = privateKey;
    this.hosts = [...hosts];
    this.#keyId = keyIdentifier(subjectPublicKeyInfo(publicKey));
    this.#subject = `Pikibun egress proxy ${this.#keyId.subarray(0, 4).toString("hex")}`;
    const issued = certificate({
      serial: serial(), issuer: this.#subject, subject: this.#subject, publicKey, signer: privateKey,
      notBefore: new Date(now.getTime() - BACKDATE_MS), notAfter: new Date(now.getTime() + CA_LIFETIME_MS),
      extensions: [
        extension("2.5.29.19", true, sequence(TRUE)),
        extension("2.5.29.15", true, bits(Buffer.from([0x06]), 1)),
        extension("2.5.29.14", false, octets(this.#keyId)),
        extension("2.5.29.30", true, sequence(tlv(0xa0, ...this.hosts.map(host => sequence(dnsName(host)))))),
      ],
    });
    this.certificate = issued.pem;
  }

  context(host: string, now = Date.now()): SecureContext {
    if (!this.hosts.includes(host)) throw new Error(`The egress proxy doesn't answer for ${host}`);
    const cached = this.#leaves.get(host);
    if (cached && cached.renewAt > now) return cached.context;
    const leaf = this.issue(host, new Date(now));
    const context = createSecureContext({ key: leaf.key, cert: `${leaf.certificate}${this.certificate}` });
    this.#leaves.set(host, { context, certificate: leaf.certificate, renewAt: now + LEAF_LIFETIME_MS - LEAF_RENEW_MS });
    return context;
  }

  issue(host: string, now = new Date()): { certificate: string; key: string } {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const leaf = certificate({
      serial: serial(), issuer: this.#subject, subject: host, publicKey, signer: this.#key,
      notBefore: new Date(now.getTime() - BACKDATE_MS), notAfter: new Date(now.getTime() + LEAF_LIFETIME_MS),
      extensions: [
        extension("2.5.29.19", true, sequence()),
        extension("2.5.29.15", true, bits(Buffer.from([0x80]), 7)),
        extension("2.5.29.37", false, sequence(oid("1.3.6.1.5.5.7.3.1"))),
        extension("2.5.29.17", false, sequence(dnsName(host))),
        extension("2.5.29.14", false, octets(keyIdentifier(subjectPublicKeyInfo(publicKey)))),
        extension("2.5.29.35", false, sequence(tlv(0x80, this.#keyId))),
      ],
    });
    return { certificate: leaf.pem, key: privateKey.export({ type: "pkcs8", format: "pem" }) as string };
  }
}

let shared: InterceptionAuthority | undefined;
export function interceptionAuthority(): InterceptionAuthority {
  shared ??= new InterceptionAuthority();
  return shared;
}
