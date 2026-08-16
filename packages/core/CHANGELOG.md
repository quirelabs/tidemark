# @quirelabs/tidemark-core

## 0.0.2

### Patch Changes

- Add an interactive terminal browser for the diff

## 0.0.1

First release.

- Schema snapshots from `pg_catalog`, with tables identified by OID so a dropped
  and recreated table is never diffed against its predecessor
- Snapshot data backend that copies tracked tables into a shadow schema and
  diffs in SQL, preserving bigint and numeric precision
- Semantic schema diff, danger classifier and redaction pass
- Versioned JSON artifact as the stable contract for renderers and integrations
