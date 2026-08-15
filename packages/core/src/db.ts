import postgres from "postgres";
import { MIN_POSTGRES_MAJOR } from "./version.ts";

export type Sql = postgres.Sql;

/**
 * Core owns the database driver so nothing downstream has to depend on it. The
 * CLI and the Action both go through here.
 */
export function connect(connectionString: string): Sql {
  return postgres(connectionString, {
    // Notices are noise for a capture run, and postgres.js prints them by default.
    onnotice: () => {},
    // A capture is a handful of sequential queries, never a server workload.
    max: 4,
  });
}

export interface ServerInfo {
  version: string;
  major: number;
  database: string;
}

export async function serverInfo(sql: Sql): Promise<ServerInfo> {
  const [row] = await sql<
    { version: string; version_num: string; database: string }[]
  >`
    select current_setting('server_version') as version,
           current_setting('server_version_num') as version_num,
           current_database() as database
  `;

  return {
    version: row?.version ?? "unknown",
    major: Math.floor(Number(row?.version_num ?? 0) / 10_000),
    database: row?.database ?? "unknown",
  };
}

export class UnsupportedPostgresError extends Error {
  readonly found: string;

  constructor(found: string) {
    super(
      `Tidemark needs Postgres ${MIN_POSTGRES_MAJOR} or newer, this server reports ${found}.`,
    );
    this.name = "UnsupportedPostgresError";
    this.found = found;
  }
}

export async function assertSupported(sql: Sql): Promise<ServerInfo> {
  const info = await serverInfo(sql);
  if (info.major < MIN_POSTGRES_MAJOR) {
    throw new UnsupportedPostgresError(info.version);
  }
  return info;
}
