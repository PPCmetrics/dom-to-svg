# Development notes

Gotchas that aren't obvious from the code, collected from real debugging sessions.
Kept short on purpose — see git history/commit messages for the reasoning behind actual bug fixes.

## Windows-specific

- `npm run eslint` uses the glob `'src/**/*.ts'`, which relies on shell glob expansion (works in
  CI/bash). PowerShell/cmd don't expand it, so the script fails with "no files matching pattern".
  Run `npx eslint src/**/*.ts` directly instead when linting locally on Windows.
- `git` commands (`git mv`, `git add`, `git status`) can fail with "Filename too long" under
  `src/test/recordings/**` (deeply nested HAR fixture paths). Run
  `git config core.longpaths true` once per clone to avoid this.
- `npx prettier --check '**/*.{yml,ts,json}'` fails on most files in a Windows checkout
  (line-ending related, pre-existing). Don't treat that as a regression signal; instead run
  prettier only against the files you actually touched.

## TypeScript / nodenext

- The `gradient-parser` type shim (`src/types/gradient-parser/index.d.ts`) must be referenced by
  its exact file path in `tsconfig.json`'s `paths`, e.g.
  `"gradient-parser": ["./src/types/gradient-parser/index.d.ts"]`. A directory-style wildcard
  (`"*": ["./src/types/*", ...]`) does **not** resolve under `moduleResolution: nodenext` — it
  doesn't fall back to `index.d.ts` for path substitutions the way older resolution modes did.
- Prettier (pinned to an older version here) requires double `as` casts written as
  `(X as unknown) as Y` — `X as unknown as Y` fails `prettier --check` even though `tsc`/eslint
  don't care.

## Tooling / dependencies

- `eslint-plugin-etc` and `eslint-plugin-rxjs` (pulled in transitively via
  `@sourcegraph/eslint-config`) declare `peerDependencies: typescript@^3||^4`. With root
  `typescript` on 5.x, npm nests these plugins instead of hoisting them, and ESLint 7 can't find
  them when they're only referenced from a shareable config (`ESLint couldn't find the plugin`).
  Fix: pin the same versions as direct devDependencies at the root so npm hoists them.
- `eslint-plugin-etc@1.3.8`'s `no-deprecated` rule crashes (`TypeError: tag.trim is not a
  function`) on code referencing a deprecated RxJS-typed symbol. Disabled via
  `"etc/no-deprecated": "off"` in `.eslintrc.json`.
- `npm test` overwrites `src/test/snapshots/*.a11y.json` (and would overwrite generated
  `.svg`/screenshots) in place while generating "actual" output to diff against. These show up as
  dirty `git status` entries after every test run regardless of pass/fail —
  `git checkout -- src/test/snapshots` to discard if you don't intend to accept new goldens.

## Testing vertical/rotated text (`writing-mode`)

The Chromium bundled with this repo's Puppeteer version doesn't support `sideways-lr`/
`sideways-rl` (it silently falls back to `horizontal-tb`), so the automated test suite can't be
used to verify vertical-writing-mode output. To check it manually:

1. `npm run build && npm run webpack` to produce `dist/dom2svg.js`.
2. Open a minimal repro HTML file in a real, up-to-date browser (e.g. VS Code's embedded browser
   tool), not via the Puppeteer test harness.
3. Inspect the generated markup directly, e.g.
   `page.evaluate(() => new XMLSerializer().serializeToString(window.dom2svg.documentToSVG(document)))`.
