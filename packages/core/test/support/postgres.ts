import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import postgres from "postgres";

export const POSTGRES_IMAGE = "postgres:17-alpine";

export interface TestDatabase {
  sql: postgres.Sql;
  connectionUri: string;
  stop: () => Promise<void>;
}

/** One container per suite. Suites run serially, see vitest.config.ts. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container: StartedPostgreSqlContainer =
    await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const connectionUri = container.getConnectionUri();
  const sql = postgres(connectionUri, { onnotice: () => {} });

  return {
    sql,
    connectionUri,
    stop: async () => {
      await sql.end();
      await container.stop();
    },
  };
}

/**
 * Drops and recreates the public schema so each test starts from nothing. Much
 * faster than a container per test and leaves no cross test residue.
 */
export async function resetPublicSchema(sql: postgres.Sql): Promise<void> {
  await sql.unsafe("drop schema if exists public cascade; create schema public");
}
