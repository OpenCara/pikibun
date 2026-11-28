# Design: the app in several languages

Status: implemented for the app's frame (navigation, page titles, the command palette's own commands, the settings
sections and **Appearance**) and its dates and relative times; the other screens still show English, and move to
translations one screen at a time.

## What it uses

The app translates with Native Shell's own i18n ([I18n](https://nsh.dev/docs/i18n), `nsh/i18n`), as its docs
recommend, rather than a library of its own:

- The texts are in `apps/nsh/locales/app.json`, one file with every language (rust-i18n's `_version: 2`): each key,
  then its text in English (`en`), Simplified Chinese (`zh`), Traditional Chinese (`zh-Hant`), Japanese (`ja`) and
  Korean (`ko`). The build reads it and the app carries it; `%{name}` patterns take the arguments.
- Components call `t("key", { name })` where the text is shown, never once into a constant: `t` follows the language,
  so a text that reads it changes in place when the language does. A section's label is a getter over `t` for the
  same reason.
- Keys name what the text is for (`nav.new_session`, `settings.section.hosts`), not the English, and a whole sentence
  is one key with its arguments, since word order differs between languages.

## Which language shows

By default, the first of the device's preferred languages the app has, or a shorter tag of it, then English. Under
**Settings → Appearance → Display language**, a person picks one for this device: `setLocale` shows it at once, and
`pikibun.language` in `Storage` keeps it, read again at start beside the theme (`apps/nsh/src/lib/language.ts`).
**System** removes it and follows the device again.

Chinese needs one more step. Apple's systems name it by script (`zh-Hans-CN`, `zh-Hant-TW`), which the shorter tags
`zh-Hans`, `zh` and `zh-Hant` match; Android and browsers name it by region (`zh-CN`, `zh-TW`, `zh-HK`), and the
shorter tag of `zh-TW` is `zh`, the simplified texts. So at start the app adds the Traditional texts under `zh-TW`,
`zh-HK` and `zh-MO` too (`addTranslations`), and a person in Taiwan or Hong Kong reads Traditional Chinese whatever
their system calls it.

## Dates and times

`relativeTime` takes its words from the translations ("5 min ago", "5 分钟前"), since Native Shell's `Intl` has no
`RelativeTimeFormat`; dates and timestamps go through `Intl.DateTimeFormat` for `locale()`, so each language writes its
own order and month names ("Mar 12, 2026" in American English). Times follow the person's 12- or 24-hour clock and
time zone (`localeSettings().hourCycle` and `timeZone`, passed to `Intl` as they are), and the formatters are kept per
language, clock and zone, so a change of any of them while the app runs makes new ones. A zone `Intl` refuses (a name
`nsh.json` doesn't list) formats in local time rather than failing. Native Shell carries the formatting data of the languages the translations
have.

## Checks

`tests/app-translations.test.ts` checks that every key has a text in each of the five languages with the same
`%{name}` patterns as English, that every key the app asks `t` for exists, and that every key is still asked for.
`apps/nsh/tests/language.test.tsx` and the language test in `routes.test.tsx` check the times in each language, the
device's language, the choice in **Appearance**, and that it is kept.

## Adding a language or a screen

- A language: add its text to every key of `locales/app.json`, to `languages` in `lib/language.ts` (by its own name,
  such as `Deutsch`), and to the languages the translation test expects.
- A screen: replace its literals with `t` keys and add them to `locales/app.json` in every language. Messages from the
  server stay English until it answers with codes the app can translate.
