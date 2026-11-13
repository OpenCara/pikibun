import type { KeyObject } from "node:crypto";

export function updateMessage(name: string, sha256: string): string;
export function releasePublicKey(source?: string): KeyObject;
export function signUpdate(file: string, privateKey: KeyObject, publicKey: KeyObject): string;
