import { setLocale } from "nsh/i18n";
import { describe, expect, test } from "nsh/test";
import { dateLabel, relativeTime, timestamp } from "../src/lib/format";
import { traditionalAliases } from "../src/lib/language";

const now = Date.UTC(2026, 10, 20, 12, 0);
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

describe("times in the language the app shows", () => {
  test("English", () => {
    setLocale("en-US");
    expect(relativeTime(ago(0), now)).toBe("just now");
    expect(relativeTime(ago(5), now)).toBe("5 min ago");
    expect(relativeTime(ago(180), now)).toBe("3 h ago");
    expect(relativeTime(ago(2 * 1440), now)).toBe("2 d ago");
    expect(dateLabel(new Date(2026, 2, 12))).toBe("Mar 12, 2026");
    setLocale(null);
  });

  test("Chinese, Japanese and Korean", () => {
    setLocale("zh-CN");
    expect(relativeTime(ago(5), now)).toBe("5 分钟前");
    setLocale("zh-Hant-TW");
    expect(relativeTime(ago(5), now)).toBe("5 分鐘前");
    setLocale("ja");
    expect(relativeTime(ago(180), now)).toBe("3 時間前");
    expect(dateLabel(new Date(2026, 2, 12))).toContain("2026");
    expect(dateLabel(new Date(2026, 2, 12))).toContain("12");
    setLocale("ko");
    expect(relativeTime(ago(2 * 1440), now)).toBe("2일 전");
    expect(relativeTime(ago(0), now)).toBe("방금");
    setLocale(null);
  });

  test("a date that does not parse is shown as it is", () => {
    expect(timestamp("never")).toBe("never");
    expect(relativeTime("never")).toBe("");
  });
});

test("Traditional Chinese answers for the regions that write it", () => {
  const aliases = traditionalAliases({ _version: 2, hello: { en: "Hello", zh: "你好", "zh-Hant": "你好嗎" } });
  expect(Object.keys(aliases).sort()).toEqual(["zh-HK", "zh-MO", "zh-TW"]);
  expect(aliases["zh-TW"]).toEqual({ hello: "你好嗎" });
});
