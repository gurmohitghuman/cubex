# Contributing to Cubex

Thanks for helping. Bug reports and ideas are welcome as GitHub issues. For anything bigger than a small fix, open an issue first so we can agree on the approach before you write the code.

## Development

Needs Node.js 22.6 or newer.

```bash
npm install
npm run dev          # client on :3000, server on :3002, both hot-reload
npm run typecheck    # server + client
npm run test:unit    # fast tests, no server
E2E_SPEC=tests/e2e scripts/e2e-harness.sh   # full browser + API suite on a throwaway database
```

The end-to-end suite needs Playwright: `npm install --no-save @playwright/test && npx playwright install chromium`.

Stack: Express and SQLite (better-sqlite3) on the server, React, Vite and AG Grid in the browser, Sidequest for background runs. Runs, autosave and column handling rely on rules that the comments at the top of those files explain; read them before changing anything there. How a release is cut: [docs/releasing.md](docs/releasing.md).

## Before you open a pull request

- Run `npm run typecheck` and `npm run test:unit`, plus the end-to-end specs for the area you changed.
- Keep each pull request to one change, and say in plain words what it lets someone do.

## Contributor agreement

Cubex is licensed under the [AGPL-3.0](LICENSE). By opening a pull request, you agree that:

1. You wrote the contribution yourself, or you have the right to submit it under these terms.
2. Your contribution is licensed under the AGPL-3.0, like the rest of Cubex.
3. You also give Gurmohit Ghuman a permanent, worldwide, free, non-exclusive and irrevocable right to use, copy, change, share and relicense your contribution, including under licenses other than the AGPL-3.0.

You keep the copyright to your work. Point 3 means Cubex's license can change in the future, and Cubex can be offered under other terms, without asking every contributor first.
