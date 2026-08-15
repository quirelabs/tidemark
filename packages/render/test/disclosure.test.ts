import {
  ARTIFACT_SCHEMA_VERSION,
  redactArtifact,
  type Artifact,
} from "@quirelabs/tidemark-core";
import { describe, expect, it } from "vitest";
import { emit, plainCapabilities, renderReport, type Capabilities } from "../src/index.ts";

const SECRET = "hunter2-the-actual-password";

function artifact(): Artifact {
  return {
    meta: {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      tidemarkVersion: "0.0.1",
      backend: "snapshot",
      capturedFrom: "2026-08-15T11:00:00.000Z",
      capturedTo: "2026-08-15T11:05:00.000Z",
      database: "shop_ci",
      postgresVersion: "17",
      rowThreshold: 50,
      redactions: [],
    },
    schema: { tablesAdded: [], tablesRemoved: [], tablesAltered: [] },
    warnings: [],
    tables: [
      {
        schema: "public",
        name: "users",
        detail: "rows",
        primaryKey: ["id"],
        columns: [
          { name: "id", dataType: "integer" },
          { name: "email", dataType: "text" },
          { name: "phone", dataType: "text" },
          { name: "tier", dataType: "text" },
          { name: "password_hash", dataType: "text" },
        ],
        counts: { inserted: 1, updated: 0, deleted: 0 },
        rowsBefore: 3,
        rows: [
          {
            op: "insert",
            key: [51],
            cells: [
              { column: "email", after: "ada@example.com" },
              { column: "phone", after: "+3161234567" },
              { column: "tier", after: "pro" },
              { column: "password_hash", after: SECRET },
            ],
          },
        ],
      },
    ],
  };
}

const PLAIN = plainCapabilities(100);

function render(config = {}, capabilities: Capabilities = PLAIN): string {
  const redacted = redactArtifact(artifact(), config);
  return emit(renderReport(redacted, capabilities, { detail: "full" }), capabilities);
}

describe("persistent disclosure", () => {
  it("states what was shown in full on every render", () => {
    expect(render()).toContain("values shown in full for 4 columns");
  });

  it("names contact PII that was left visible", () => {
    const out = render();
    expect(out).toContain("including email, phone");
  });

  it("lists what was withheld and how to change it", () => {
    const out = render();
    expect(out).toContain("1 column redacted: public.users.password_hash (mask)");
    expect(out).toContain("configure masking in tidemark.config.ts");
  });

  it("still discloses when nothing was redacted", () => {
    const out = render({ allow: [{ column: "password_hash" }] });
    expect(out).toContain("values shown in full for 5 columns");
    expect(out).not.toContain("redacted:");
    expect(out).toContain("configure masking in tidemark.config.ts");
  });

  it("says nothing when there is no data to disclose about", () => {
    const empty: Artifact = { ...artifact(), tables: [] };
    const out = emit(renderReport(empty, PLAIN), PLAIN);
    expect(out).not.toContain("values shown in full");
  });
});

describe("redacted values never reach output", () => {
  const capabilities: Capabilities[] = [
    plainCapabilities(100),
    { color: true, glyphs: "unicode", width: 100 },
    { color: false, glyphs: "ascii", width: 100 },
    plainCapabilities(40),
  ];

  it("holds across every capability combination", () => {
    for (const caps of capabilities) {
      const out = render({}, caps);
      expect(out).not.toContain(SECRET);
      expect(out).toContain("[masked]");
    }
  });

  it("holds for every detail level", () => {
    for (const detail of ["auto", "summary", "full"] as const) {
      const redacted = redactArtifact(artifact());
      const out = emit(renderReport(redacted, PLAIN, { detail }), PLAIN);
      expect(out).not.toContain(SECRET);
    }
  });

  it("shows a hash as a value, not as a label", () => {
    const out = render({ redact: [{ column: "password_hash", mode: "hash" }] });
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("[masked]");
    expect(out).toMatch(/password_hash=#[0-9a-f]{12}/);
  });

  it("keeps the visible columns visible", () => {
    const out = render();
    expect(out).toContain("ada@example.com");
    expect(out).toContain("tier=pro");
  });
});
