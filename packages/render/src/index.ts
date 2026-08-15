export { codePointWidth, stringWidth, truncateToWidth } from "./text/width.ts";

export { makeDisplaySafe } from "./value/safe-text.ts";
export type { SafeText } from "./value/safe-text.ts";

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
export { glyphsFor } from "./report/glyphs.ts";
export type { Glyphs } from "./report/glyphs.ts";
