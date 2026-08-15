# @quirelabs/tidemark-core

Capture backends, schema snapshots, the semantic diff engine and the artifact
schema behind [Tidemark](https://github.com/quirelabs/tidemark).

Most people want the CLI instead:

```sh
pnpm add -D @quirelabs/tidemark
```

This package is the programmatic interface, for building your own tooling on top
of the same capture and diff pipeline.

```ts
import {
  buildArtifact,
  connect,
  startSnapshotCapture,
  stopSnapshotCapture,
} from "@quirelabs/tidemark-core";

const sql = connect(process.env.DATABASE_URL);
const handle = await startSnapshotCapture(sql);
// ...something changes the database...
const capture = await stopSnapshotCapture(sql, handle);
```

The JSON artifact is the stable contract: renderers and integrations depend on it
and on nothing else here.

Postgres 15+ only. Requires Node 22.18+.

Apache 2.0, Quire Labs.
