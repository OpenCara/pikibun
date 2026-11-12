import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { encodeQr, qrPath } from "../apps/nsh/src/lib/qr.js";

const digest = (matrix: boolean[][]) => createHash("sha256").update(matrix.map(row => row.map(dark => (dark ? "1" : "0")).join("")).join("\n")).digest("hex");
const link = "pikibun://auth/code?server=https%3A%2F%2Fpikibun.com&code=0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

test("the app's QR codes are module for module those of another encoder (python-qrcode 8.2, byte mode, level M)", () => {
  // Each digest is python-qrcode's matrix for the same text and mask, its rows of 0 and 1 joined by newlines.
  const cases: [string, number, number, string][] = [
    ["a", 0, 21, "ad65f877bf9411d14b0b2efbc0ca7dfffd44b86e4c5f662689ac17016c5d1b0e"],
    [link, 3, 41, "ab6a5629d3787dfa77d7c8946a34504b8dd801251ba67e5ead8ba0ad023a1792"],
    [link, 6, 41, "c461c9c0c971e49037e4dd78d1c393bef8941bbc8f36e66b3772321029096978"],
    ["Grüße, 世界", 5, 25, "90dbce18b0e233fa731db05b50287251601174327a49b15d8930064fd75ad093"],
    ["x".repeat(1480), 2, 145, "bdd82b352b473b24cd8a833bfb1ccd37ff11236aaf2763871bcd7af5233329f2"],
  ];
  for (const [text, mask, size, expected] of cases) {
    const matrix = encodeQr(text, mask);
    assert.equal(matrix.length, size);
    assert.ok(matrix.every(row => row.length === size));
    assert.equal(digest(matrix), expected, `${text.slice(0, 20)} with mask ${mask}`);
  }
});

test("a QR code picks one of the eight masks, and its path fills exactly the dark modules inside the quiet zone", () => {
  const chosen = digest(encodeQr(link));
  assert.ok([0, 1, 2, 3, 4, 5, 6, 7].some(mask => digest(encodeQr(link, mask)) === chosen));
  const matrix = encodeQr("a", 0);
  const path = qrPath(matrix);
  const filled = new Set<string>();
  for (const [, x, y, width] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let i = 0; i < Number(width); i++) filled.add(`${Number(x) + i - 4},${Number(y) - 4}`);
  }
  const dark = matrix.flatMap((row, y) => row.flatMap((value, x) => (value ? [`${x},${y}`] : [])));
  assert.deepEqual([...filled].sort(), dark.sort());
  assert.throws(() => encodeQr("x".repeat(2400)), /too long/);
});
