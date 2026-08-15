import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { TidemarkConfig } from "./types.ts";

/**
 * Config is a TypeScript file imported directly. Node strips the types itself,
 * so there is no loader dependency and users still get autocomplete on the
 * redaction rules, which is the part that is easiest to get wrong.
 */
const CONFIG_NAMES = [
  "tidemark.config.ts",
  "tidemark.config.mts",
  "tidemark.config.js",
  "tidemark.config.mjs",
];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface LoadedConfig {
  config: TidemarkConfig;
  /** Absolute path, or null when running on defaults. */
  path: string | null;
}

export async function loadConfig(
  explicit?: string,
  cwd: string = process.cwd(),
): Promise<LoadedConfig> {
  const path =
    explicit === undefined
      ? await findConfig(cwd)
      : isAbsolute(explicit)
        ? explicit
        : resolve(cwd, explicit);

  if (path === null) return { config: {}, path: null };

  if (!(await isFile(path))) {
    throw new ConfigError(`No config file at ${path}`);
  }

  return { config: await importConfig(path), path };
}

/** Walks up to the filesystem root, the way every other JS tool does. */
async function findConfig(cwd: string): Promise<string | null> {
  const { root } = parse(cwd);
  let directory = cwd;

  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(directory, name);
      if (await isFile(candidate)) return candidate;
    }
    if (directory === root) return null;
    directory = dirname(directory);
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function importConfig(path: string): Promise<TidemarkConfig> {
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(path).href);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ConfigError(`Could not load ${path}: ${detail}`);
  }

  const module = loaded as { default?: unknown; config?: unknown };
  const value = module.default ?? module.config;

  if (value === undefined) {
    throw new ConfigError(
      `${path} has no default export. Export your config as default, wrapped in defineConfig().`,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${path} must export an object, got ${typeof value}.`);
  }

  return value as TidemarkConfig;
}

export class MissingConnectionError extends Error {
  constructor() {
    super(
      "No database connection. Pass --connection, set DATABASE_URL, or add `connection` to your config.",
    );
    this.name = "MissingConnectionError";
  }
}

export function resolveConnection(
  flag: string | undefined,
  config: TidemarkConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const connection = flag ?? config.connection ?? env["DATABASE_URL"];
  if (connection === undefined || connection === "") {
    throw new MissingConnectionError();
  }
  return connection;
}

/** Capture options derived from config, with unset keys omitted entirely. */
export function captureOptionsFrom(config: TidemarkConfig) {
  return {
    ...(config.schemas === undefined ? {} : { schemas: config.schemas }),
    ...(config.rowThreshold === undefined
      ? {}
      : { rowThreshold: config.rowThreshold }),
    ...(config.sampleSize === undefined ? {} : { sampleSize: config.sampleSize }),
  };
}
