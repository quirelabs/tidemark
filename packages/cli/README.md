# @quirelabs/tidemark

Capture what an AI agent or a migration actually did to your Postgres database,
and review it as a semantic state diff.

```sh
pnpm add -D @quirelabs/tidemark
```

```sh
tidemark snapshot        # record the baseline
pnpm migrate             # or let your agent do whatever it does
tidemark diff            # render what changed
```

Schema changes render like a migration file, data changes render as rows, bulk
changes are aggregated and sampled rather than dumped, and dangerous operations
are flagged at the top. Credential-looking columns are masked before anything is
serialized.

Every value is treated as untrusted input, so a row that contains ANSI escapes,
line breaks or bidi overrides cannot forge or hide part of the diff reviewing it.

Postgres 15+ only. Requires Node 22.18+.

Full documentation: https://github.com/quirelabs/tidemark

Apache 2.0, Quire Labs.
