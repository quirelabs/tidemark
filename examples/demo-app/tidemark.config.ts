import type { TidemarkConfig } from "@quirelabs/tidemark-core";

const config: TidemarkConfig = {
  // password_hash is masked by the built in credential patterns already.
  // Email is shown by default, so mask it here to keep the demo output safe to
  // publish, and to show the config working.
  redact: [{ table: "users", column: "email", mode: "hash" }],
  rowThreshold: 50,
};

export default config;
