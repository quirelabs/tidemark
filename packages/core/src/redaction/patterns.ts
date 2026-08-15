/**
 * Column names that look like credentials are masked by default. Contact PII
 * (email, phone, address, date of birth) is deliberately not on this list: it is
 * frequently the most useful column in a data diff, masking it by default makes
 * the first run look broken, and nearly everyone would allowlist it immediately,
 * which teaches people to weaken their config on day one.
 *
 * Because the default shows more than a deny-by-default tool would, every report
 * carries a persistent disclosure of what was left visible.
 */
export const DEFAULT_SENSITIVE_PATTERNS: readonly RegExp[] = [
  /pass(word|wd|phrase)?(_?hash)?$/i,
  /_?secret$/i,
  /(^|_)secret/i,
  /(^|_)token$/i,
  /api_?key/i,
  /private_?key/i,
  /(^|_)session(_?id)?$/i,
  /credit_?card|card_?number|(^|_)cvv$/i,
  /(^|_)ssn$|social_security/i,
  /(^|_)salt$/i,
];

export function isSensitiveColumn(
  column: string,
  patterns: readonly RegExp[] = DEFAULT_SENSITIVE_PATTERNS,
): boolean {
  return patterns.some((pattern) => pattern.test(column));
}

/**
 * Not redacted, but named in the disclosure footer. These are the columns a
 * reviewer would most want to know were printed in full, so the report says so
 * on every run rather than assuming someone read the docs once.
 */
export const NOTABLE_PII_PATTERNS: readonly RegExp[] = [
  /e?mail/i,
  /phone|mobile|msisdn/i,
  /address|street|postcode|zip/i,
  /(^|_)dob$|birth/i,
  /(^|_)ip(_?address)?$/i,
  /passport|national_?id|tax_?id/i,
];

export function isNotablePii(column: string): boolean {
  return NOTABLE_PII_PATTERNS.some((pattern) => pattern.test(column));
}

/** Column and table matchers accept a leading or trailing `*`. */
export function globMatches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}
