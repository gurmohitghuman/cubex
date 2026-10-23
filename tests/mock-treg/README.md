# Mock treg

A stand-in for [treg.to](https://treg.to), so enrichment specs never reach the real treg or spend
money. `scripts/e2e-harness.mjs` starts it on port 3098 (`E2E_TREG_PORT`), points the server at it
with `TREG_BASE_URL`, and gives specs its address as `E2E_TREG` (see `tests/e2e/helpers-treg.ts`).

Run it by hand to point a preview at it:

```
node tests/mock-treg/server.mjs 3096
TREG_BASE_URL=http://127.0.0.1:3096 ... node server/dist/index.js
```

## What it answers

- Account reads: `GET /usage/me`, `/auth/me`, `/orgs/7/balance`.
- The public catalog: `/catalog/search` (a plain word match), `/catalog/endpoints/{id}` and
  `/catalog/platforms`.
- `GET /catalog/endpoints/{id}/access`. For a waterfall it plans for the tool's own example input
  only, as treg does, so providers that need other inputs are left out of the plan.
- `/call/...` and `/calls/{id}/result`: tool calls (calls.mjs), with failure scenarios steered
  through `/__mock/state`.

Keys: anything starting `treg_mock_` is a team key. `treg_mock_personal…` is a personal login
token (400 "choose an org"), `treg_mock_setup…` a team that hasn't finished setup. Anything else is
refused (401).

## Control routes

- `GET /__mock/state` and `POST /__mock/state` with any of `balanceMicro`, `holdsMicro`,
  `ownKeys` (provider slugs the team has its own key for), `freeProviders` (free public routes),
  `down` (drop every connection, like an unreachable treg), and for tool calls `scenario`,
  `delayMs`, `findMisses`, `sameEmail`, `verifiedDomains`, `verdicts` (see calls.mjs and
  answers.mjs), `listSizes` (list jobs answer each provider's own row shape, at most `limit` rows,
  and a search mentioning a listed word at most that many, 0 for an answer with an empty list: lists.mjs), `badDomains` (a call whose request mentions one answers treg's 400
  `catalog_parameter_invalid`, so its row fails) and `bigRawDomains` (a hit whose request mentions one
  carries a long `raw.sources` list, about 30 KB, so Cubex keeps only part of it), and `aiQuiet` (AI engine ids
  whose answers cite no sources) and `aiAlsoNames` (`{engine: brand}`: that engine's answer names the brand too). The AI engines (cloro's scrapers, treg's Perplexity job) answer from the question
  with made-up brands and generic sites (ai-search.mjs), so specs can check which brands an answer names.
- `GET /__mock/billing`: every charge, by Idempotency-Key. `GET /__mock/state` also has
  `inFlightCount`, the calls still being answered: a spec that stops a run waits for 0 before
  checking the bill, so a late charge never lands in the next spec's log.
- `POST /__mock/reset`: back to the defaults ($1.00, no own keys) with an empty request log.
- `GET /__mock/requests`: what Cubex called. Header names and values are kept, except the key,
  which is only marked as sent.

## Fixtures

Captured from the live treg on 2026-10-07 with a team key. The paid calls cost $0.0133 in total,
and the balance moved by exactly the sum of the `X-Treg-Cost-Micro` headers. Everything personal was
replaced: people are fictional (Ada Lovelace, Grace Hopper), domains are `.example`, call ids are
`c0ffee…`, the team is `acme` (id 7), and the key never left the capture script.

- `catalog/`: tool details for the Popular jobs and a few single tools, slimmed to the fields Cubex
  reads (raw field names kept), and search rows for common words. The people in treg's examples are
  swapped for fictional ones too: keep real people's data out of this repo.
- `access/`, `account/`: as treg answered.
- `calls/`: one live answer each (status, `X-Treg-*` headers, body), with a `note` on what it
  shows: a hit, its free replay, a repeat lookup at 10% (treg's archive), a miss, a capped miss,
  the 402s (`route_max_cost`, `insufficient_balance`), a reused key, verify verdicts, a list, single
  tools, and refusals. `tests/unit/treg-live-fixtures.test.ts` checks Cubex's reading of each.
