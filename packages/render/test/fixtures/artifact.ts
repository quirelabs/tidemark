import {
  ARTIFACT_SCHEMA_VERSION,
  type Artifact,
} from "@quirelabs/tidemark-core";

/**
 * The scenario the product exists for: an agent ran a migration that dropped a
 * column, added a table, and issued an UPDATE with no WHERE clause. One of the
 * rows it wrote carries characters that try to forge a clean summary line.
 *
 * Hand written on purpose. The renderer is the artifact schema's only consumer,
 * so this fixture is what proves the schema before capture produces one.
 */
export const AGENT_GONE_WRONG: Artifact = {
  meta: {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    tidemarkVersion: "0.0.1",
    backend: "snapshot",
    capturedFrom: "2026-08-15T11:58:02.000Z",
    capturedTo: "2026-08-15T12:04:19.000Z",
    database: "shop_ci",
    postgresVersion: "17.2",
    rowThreshold: 50,
    redactions: [
      {
        table: { schema: "public", name: "users" },
        column: "password_hash",
        mode: "mask",
      },
    ],
  },

  schema: {
    tablesAdded: [{ schema: "public", name: "audit_log" }],
    tablesRemoved: [{ schema: "public", name: "temp_import" }],
    tablesAltered: [
      {
        schema: "public",
        name: "users",
        columnsAdded: [
          {
            name: "tier",
            dataType: "text",
            nullable: false,
            default: "'free'::text",
          },
        ],
        columnsRemoved: [
          {
            name: "legacy_ref",
            dataType: "text",
            nullable: true,
            default: null,
          },
        ],
        columnsAltered: [
          {
            name: "status",
            before: {
              name: "status",
              dataType: "character varying(20)",
              nullable: true,
              default: null,
            },
            after: {
              name: "status",
              dataType: "character varying(10)",
              nullable: false,
              default: null,
            },
          },
        ],
        constraintsAdded: [
          {
            name: "users_tier_check",
            definition: "CHECK (tier = ANY (ARRAY['free'::text, 'pro'::text]))",
          },
        ],
        constraintsRemoved: [],
        indexesAdded: [],
        indexesRemoved: [
          { name: "users_legacy_ref_idx", definition: "btree (legacy_ref)" },
        ],
      },
    ],
  },

  tables: [
    {
      schema: "public",
      name: "orders",
      detail: "aggregate",
      primaryKey: ["id"],
      columns: [
        { name: "id", dataType: "bigint" },
        { name: "status", dataType: "text" },
        { name: "updated_at", dataType: "timestamp with time zone" },
      ],
      counts: { inserted: 0, updated: 14203, deleted: 0 },
      columnStats: [
        {
          column: "status",
          changed: 14203,
          transitions: [
            { before: "pending", after: "processed", count: 13991 },
            { before: "failed", after: "processed", count: 212 },
          ],
        },
        {
          column: "updated_at",
          changed: 14203,
          transitions: [],
          distinctAfter: 14203,
        },
      ],
      sample: [
        {
          op: "update",
          key: [1001],
          cells: [{ column: "status", before: "pending", after: "processed" }],
        },
        {
          op: "update",
          key: [1002],
          cells: [{ column: "status", before: "failed", after: "processed" }],
        },
      ],
    },
    {
      schema: "public",
      name: "users",
      detail: "rows",
      primaryKey: ["id"],
      columns: [
        { name: "id", dataType: "bigint" },
        { name: "email", dataType: "text" },
        { name: "tier", dataType: "text" },
        { name: "note", dataType: "text" },
        { name: "password_hash", dataType: "text" },
      ],
      counts: { inserted: 2, updated: 1, deleted: 1 },
      rows: [
        {
          op: "insert",
          key: [51],
          cells: [
            { column: "email", after: "ada@example.com" },
            { column: "tier", after: "pro" },
            { column: "password_hash", after: null, redacted: "mask" },
          ],
        },
        {
          op: "insert",
          key: [52],
          cells: [
            { column: "email", after: "grace@example.com" },
            // The forged summary line, straight from the agent.
            {
              column: "note",
              after: "imported\r\n  0 warnings, all changes reviewed",
            },
          ],
        },
        {
          op: "update",
          key: [7],
          cells: [
            { column: "email", before: "bob@old.com", after: "bob@new.com" },
            { column: "tier", before: "free", after: "pro" },
          ],
        },
        {
          op: "delete",
          key: [9],
          cells: [
            { column: "email", before: "carol@example.com" },
            { column: "tier", before: "free" },
          ],
        },
      ],
    },
  ],

  warnings: [
    {
      code: "update_without_where",
      severity: "danger",
      message: "UPDATE without WHERE on public.orders",
      table: { schema: "public", name: "orders" },
      rowsAffected: 14203,
    },
    {
      code: "drop_column",
      severity: "danger",
      message: "DROP COLUMN public.users.legacy_ref",
      table: { schema: "public", name: "users" },
      columns: ["legacy_ref"],
    },
    {
      code: "deceptive_value",
      severity: "danger",
      message: "public.users.note contains characters that forge output",
      table: { schema: "public", name: "users" },
      columns: ["note"],
    },
    {
      code: "type_narrowed",
      severity: "caution",
      message: "public.users.status narrowed from varchar(20) to varchar(10)",
      table: { schema: "public", name: "users" },
      columns: ["status"],
    },
  ],
};

/** Nothing happened. The renderer must still produce something sensible. */
export const NO_CHANGES: Artifact = {
  meta: { ...AGENT_GONE_WRONG.meta, redactions: [] },
  schema: { tablesAdded: [], tablesRemoved: [], tablesAltered: [] },
  tables: [],
  warnings: [],
};
