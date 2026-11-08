import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { colorTokens, themes, type ThemeName } from "../apps/nsh/src/tokens.ts";

// The Native Shell client draws with the web app's design tokens (apps/nsh/src/tokens.ts); this keeps them the same
// colors as the stylesheet's, so a change to one client's look is a change to both.

const stylesheet = await readFile(new URL("../apps/web/src/styles.css", import.meta.url), "utf8");

/** A theme's block of @layer tokens. */
function block(selector: string): string {
  const start = stylesheet.indexOf(`${selector} {`);
  assert.ok(start >= 0, `styles.css has no ${selector} block`);
  return stylesheet.slice(start, stylesheet.indexOf("}", start));
}

/** The custom properties a theme's block declares, by name without the leading "--". */
function declared(selector: string): Map<string, string> {
  return new Map([...block(selector).matchAll(/--([\w-]+):\s*([^;]+);/g)].map(match => [match[1]!, match[2]!.trim()]));
}

/** A CSS color as #rrggbb, or #rrggbbaa when translucent: `#abc`, `#aabbcc`, `rgb(r g b / a%)`. */
function normalized(value: string): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) return `#${hex[1]!.length === 3 ? [...hex[1]!].map(digit => digit + digit).join("") : hex[1]!}`.toLowerCase();
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+)%)?\s*\)$/.exec(value);
  assert.ok(rgb, `not a color this test reads: ${value}`);
  const channels = rgb.slice(1, 4).map(channel => Number(channel).toString(16).padStart(2, "0")).join("");
  const alpha = rgb[4] === undefined ? "" : Math.round(255 * Number(rgb[4]) / 100).toString(16).padStart(2, "0");
  return `#${channels}${alpha}`;
}

const selectors: Record<ThemeName, string> = { light: ':root, [data-theme="light"]', dark: '[data-theme="dark"]', pikibun: '[data-theme="pikibun"]' };

for (const [name, selector] of Object.entries(selectors) as [ThemeName, string][]) {
  test(`the native client's ${name} theme has the web app's colors`, () => {
    const web = declared(selector);
    for (const token of colorTokens) {
      const value = web.get(token);
      assert.ok(value, `styles.css's ${name} theme doesn't declare --${token}; drop it from apps/nsh/src/tokens.ts too`);
      assert.equal(themes[name].colors[token], normalized(value), `--${token} in the ${name} theme`);
    }
    assert.equal(themes[name].scheme, /color-scheme:\s*(\w+)/.exec(block(selector))?.[1], `the ${name} theme's color-scheme`);
  });
}

test("the native client reads every color token the web app's themes declare", () => {
  // Tokens the native client has no use for yet: the diff colors (no diff view), and --shadow, whose two layers NSH
  // can't draw (tokens.ts has a single-layer one).
  const unused = new Set(["diff-add", "shadow"]);
  const web = [...declared(selectors.light).keys()].filter(token => !unused.has(token));
  assert.deepEqual(web.filter(token => !(colorTokens as readonly string[]).includes(token)), [],
    "styles.css declares a token apps/nsh/src/tokens.ts doesn't: add it there (and use it), or list it here as unused");
});
