# Tidemark

Your agent just ran a migration against the branch database. The PR diff shows
you the SQL. It does not show you that the migration updated 14,203 rows because
the `WHERE` clause was missing.

Tidemark captures what actually happened to a Postgres database and renders it
as a reviewable semantic state diff: schema changes as a migration file, data
changes as rows, bulk changes as aggregates, and the dangerous ones flagged at
the top. Then it posts that diff on your pull request.

**Status: v0.0.1, phase 0 of 5.** Repo scaffold and the real-Postgres test
harness are in. Capture, diff and the Action are not.

## What it looks like

<!-- GIF PLACEHOLDER: PR comment catching a no-WHERE UPDATE on 14k rows -->
<!-- GIF PLACEHOLDER: terminal render of a mixed schema + data diff -->

```
3 tables · +142 · ~14,203 · −8 · 1 schema change · 2 warnings

  ! UPDATE without WHERE on orders (14,203 rows)
  ! DROP COLUMN users.legacy_ref (destructive)
```

## Install

```sh
pnpm add -D @quirelabs/tidemark
```

## Use

```sh
tidemark snapshot                 # record the baseline
pnpm migrate                      # or: your agent does whatever it does
tidemark diff                     # render what changed
```

In CI, the GitHub Action wraps that same sequence and posts a sticky PR comment.

## How it works

Schema changes come from before/after `pg_catalog` snapshots. Logical decoding
never carries DDL, so this half is snapshot-based unconditionally.

Data changes come from a pluggable backend. v1 ships the snapshot differ, which
works on any stock Postgres 15+ with zero server configuration. A logical
replication backend (`pgoutput`, no extension required) follows, adding
per-transaction ordering and, eventually, statement attribution.

Any operation touching more rows than the threshold is aggregated and sampled,
never listed in full. Tidemark is a review tool, not a data exfiltration tool.

## Redaction

Tidemark writes real row values into pull request comments, so columns whose
names look sensitive (`password`, `token`, `secret`, `api_key`, `email` and
friends) are masked by default. Override in either direction in
`tidemark.config.ts`. Redaction runs before serialization, so masked values
never reach the JSON artifact either.

## What leaves your machine

Nothing, except the artifact you choose to publish. There is no hosted service,
no telemetry and no account. The GitHub Action is the only integration, and it
talks only to your own repository.

## Not in v1

- No merge-back or conflict resolution
- No hosted UI or SaaS
- No capture against production databases, only databases you control (CI
  service containers, template databases, local dev)
- No MySQL or other engines, Postgres 15+ only
- No per-agent provenance beyond statement attribution

## Development

Requires Node 22.18+ and a running Docker daemon. Tests run against real
Postgres via testcontainers.

```sh
pnpm install
pnpm test
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
