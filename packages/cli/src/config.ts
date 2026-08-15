/**
 * Config loading lives in core so the CLI and the GitHub Action share one
 * implementation rather than drifting apart.
 */
export {
  captureOptionsFrom,
  ConfigError,
  loadConfig,
  MissingConnectionError,
  resolveConnection,
} from "@quirelabs/tidemark-core";
export type { LoadedConfig } from "@quirelabs/tidemark-core";
