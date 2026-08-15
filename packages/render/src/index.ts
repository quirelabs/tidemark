export { codePointWidth, stringWidth, truncateToWidth } from "./text/width.ts";

// Re-exported from core, where hazard detection now lives.
export { makeDisplaySafe, scanHazards } from "@quirelabs/tidemark-core";
export type { SafeText } from "@quirelabs/tidemark-core";

export { renderValue } from "./value/render.ts";
export type {
  GlyphMode,
  Hazard,
  HazardType,
  RenderedValue,
  ValueKind,
  ValueRenderOptions,
} from "./value/types.ts";

export {
  detectCapabilities,
  plainCapabilities,
} from "./style/capabilities.ts";
export type { Capabilities, DetectOptions } from "./style/capabilities.ts";

export { emit, lineText, lineWidth, pad, span } from "./style/style.ts";
export type { Line, Span, StyleName } from "./style/style.ts";

export { renderReport } from "./report/report.ts";
export type { ReportOptions } from "./report/report.ts";
export { COMMENT_MARKER, renderMarkdown } from "./report/markdown.ts";
export type { MarkdownOptions } from "./report/markdown.ts";
export { glyphsFor } from "./report/glyphs.ts";
export type { Glyphs } from "./report/glyphs.ts";
