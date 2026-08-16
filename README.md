# Tidemark

Your agent just ran a migration against the branch database. The pull request
shows you the SQL. It does not show you that the migration updated 14,203 rows
because the `WHERE` clause never made it in.

Tidemark captures what actually happened to a Postgres database and renders it
as a reviewable semantic state diff: schema changes as a migration file, data
changes as rows, bulk changes as aggregates, and the dangerous ones flagged at
the top. Then it posts that on your pull request.

**Status: v0.0.1, phases 0 to 4 complete.** Capture, diff, redaction, the CLI
and the GitHub Action all work end to end against real Postgres. Not yet
published to npm.

## What it catches

```
tidemark  shop_ci · snapshot backend

  2 tables · +1 ~14,204 · 3 schema · ⚠ 4 danger 1 caution

━━ DANGER ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  every row updated on public.orders, which usually means UPDATE  14,203 rows
  ██████████████████████  14,203 of 14,203 rows  100%

  DROP COLUMN public.users.legacy_ref
  credential column changed on public.users: password_hash
  public.users contains values that can forge or hide output: note

━━ DATA ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  public.orders                              ~14,203 of 14,203  100% ████████
    status      14,061  █████████████████▉  pending → processed
                   142  ▏                   failed → processed
    updated_at  14,203  ██████████████████  identical, folded

    sample, 10 of 14,203 rows
      ~ id=1    status pending → processed
      ~ id=100  status failed → processed
      updated_at moved identically on all 10 sampled rows

  public.users                                        +1 ~1 of 40    3% ▎
    + id=41  email=#46480b384554  password_hash=[masked]  tier=free
    ~ id=2   password_hash=[masked]
```

"14,203 rows changed" means nothing until you know the table holds 14,203 rows.
Every finding and every table carries the share it touched, so a full-table
rewrite is a red bar you see before you read a word, and the shape of a bulk
change is visible: 14,061 rows moved one way and 142 moved another.

<!-- GIF PLACEHOLDER: PR comment catching the no-WHERE UPDATE on 14k rows -->
<!-- GIF PLACEHOLDER: terminal render of a mixed schema and data diff -->

Run it yourself: `pnpm e2e` spins up Postgres, runs a scripted "agent gone
wrong" migration, and prints exactly what the Action would post.

## Install

```sh
pnpm add -D @quirelabs/tidemark
```

## Use locally

```sh
tidemark snapshot                 # record the baseline
pnpm migrate                      # or let your agent do whatever it does
tidemark diff                     # browse what changed
```

In a terminal, `diff` opens a browser: findings, schema and data as a navigable
outline on the left, detail on the right.

```
 tidemark   shop_ci  snapshot backend
 2 tables  +1  ~14,204  ⚠ 4 danger  1 caution
──────────────────────────────────────────────────────────────────────────────
▾ DANGER  4                          │ every row updated on public.orders,
    every row updated on public.or…  │ which usually means UPDATE without WHERE
    DROP COLUMN public.users.legac…  │
    credential column changed on p…  │ ████████████████████████████████
▾ SCHEMA  3                          │ 14,203 of 14,203 rows  100%
    + public.audit_log               │
▾ DATA  2                            │ code     update_without_where
    public.orders  ~14,203  100%     │ table    public.orders
    public.users  +1 ~1  3%          │
 ↑↓ move  → expand  J/K scroll  tab all  / search  ? help  q quit
```

`↑↓` or `jk` to move, `→` to expand, `tab` to filter, `/` to search, `?` for
help, `q` to quit. Pipe the output anywhere, or pass `--plain`, and you get the
stream renderer instead. CI has no terminal, so it always gets the stream.

`tidemark branch scratch main_db` makes a throwaway database from a template, so
a capture never runs against the one you care about.

## Use in CI

```yaml
name: Database review
on: pull_request

jobs:
  tidemark:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    services:
      postgres:
        image: postgres:17-alpine
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: app_ci
        ports: ["5432:5432"]
        options: >-
          --health-cmd pg_isready --health-interval 5s --health-retries 10

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22.18

      - run: psql "$DATABASE_URL" -f db/seed.sql
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/app_ci

      - uses: quirelabs/tidemark@v0
        with:
          connection: postgres://postgres:postgres@localhost:5432/app_ci
          run: pnpm migrate
          fail-on: danger
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

The Action captures a baseline, runs your command, builds the diff, writes it to
the job summary, and posts it as a sticky pull request comment that it updates in
place rather than posting again on every push.

**Do not put anything from the event payload into `run:`.** It is a shell script,
exactly like a `run:` step, so treat it with the same care. Tidemark never
interpolates event data into it, and it invokes everything else with argument
arrays rather than a shell.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Nothing tripped the threshold |
| 1 | Tidemark itself failed |
| 2 | `fail-on` threshold met |

Two codes rather than one, so a red check is never ambiguous about whether the
tool broke or the tool objected.

## How it works

Schema changes come from before and after `pg_catalog` snapshots. Logical
decoding never carries DDL, so this half is snapshot based unconditionally.
Tables are matched by OID, so a table dropped and recreated under the same name
reads as a removal plus an addition rather than being diffed against a stranger.

Data changes come from a pluggable backend. v1 ships the snapshot differ, which
copies tracked tables into a shadow schema and diffs old against new in SQL. It
works on any stock Postgres 15+ with zero server configuration. A logical
replication backend (`pgoutput`, no extension required) follows, adding
per-transaction ordering and, eventually, statement attribution.

Anything touching more rows than the threshold is aggregated and sampled, never
listed in full, and the sample is drawn across the distinct shapes of the change
rather than the first rows by key. Tidemark is a review tool, not a data
exfiltration tool.

## Values are treated as hostile input

Tidemark renders values an agent may have written seconds earlier, into your
terminal and into a frequently public pull request comment. Those bytes are
untrusted.

A value carrying `\r\n  0 warnings, all changes reviewed` would otherwise print
what looks like a clean bill of health inside the diff reviewing it. One
carrying `\x1b[1A\x1b[2K` would erase the warning line above it. A bidi override
makes text render in an order that does not match its bytes.

So every value passes through a fidelity layer that reveals those characters
rather than stripping them, because stripping hides the evidence that something
tried to deceive. Two guarantees hold, both pinned by a fuzz test over a hostile
alphabet:

1. A value can never change how anything around it reads.
2. Two values that differ never render the same, which is why `NULL`, `'NULL'`,
   `''` and `'  '` all look different.

## Redaction

Columns whose names look like credentials (`password`, `secret`, `token`,
`api_key`, `private_key`, `session`, `credit_card`, `ssn`) are masked by default.

Contact PII such as `email` and `phone` is **not** masked by default. It is
often the most useful column in a data diff, and masking it out of the box would
make the first run look broken and teach everyone to weaken their config
immediately. Because the default shows more than a deny-everything tool would,
every report carries a footer stating what it left visible.

```ts
import { defineConfig } from "@quirelabs/tidemark";

export default defineConfig({
  redact: [
    { table: "users", column: "email", mode: "hash" },
    { column: "stripe_*" },
  ],
  allow: [{ column: "session_kind" }],
});
```

`mask` drops the value, `hash` emits a stable digest so "changed" is still
distinguishable from "unchanged", `truncate` keeps four characters. Explicit
rules beat `allow`, which beats the built in patterns. Primary keys are redacted
too, so a rule cannot be bypassed by putting the secret in the key.

Redaction runs before serialization, so a masked value never reaches the JSON
artifact either, let alone the artifact CI uploads.

## What leaves your machine

Nothing, except the artifact you choose to publish. No hosted service, no
telemetry, no account. The GitHub Action is the only integration and it talks
only to your own repository.

## Not in v1

- No merge-back or conflict resolution
- No hosted UI or SaaS
- No capture against production databases, only ones you control: CI service
  containers, template databases, local dev
- No MySQL or other engines, Postgres 15+ only
- No per-statement attribution on the snapshot backend, so "without WHERE" is
  inferred from every row having changed, and the message says so

## Development

Requires Node 22.18+ and a running Docker daemon. Capture and diff correctness is
tested against real Postgres via testcontainers, never against a mock.

```sh
pnpm install
pnpm test        # unit and integration
pnpm e2e         # the full pipeline, through the Action
pnpm typecheck
pnpm build
```

### Constraints this project holds itself to

- Postgres 15+ only. No dialect abstraction layer.
- The diff is the product. Rendering quality gets the polish budget.
- Never dump bulk data. Anything over the threshold is aggregated and sampled.
- Redaction runs before serialization, so masked values never reach the artifact.
- Capture and diff correctness is tested against real Postgres, never a mock.

## License

Apache 2.0, Quire Labs.
