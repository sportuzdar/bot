/**
 * Deterministic sanitizers for untrusted source text. No LLM, no eval.
 * Output is plain text only; React escapes it on display and it is never
 * interpreted as instructions anywhere in the crawler.
 */

import { CRAWLER_LIMITS } from "./limits.js";

const CONTROL_CHARS = new RegExp(
  "[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]",
  "g",
);

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/**
 * Strip markup in linear time (no backtracking regexes): decode entities
 * FIRST, then drop tags and script/style bodies, then drop stray angle
 * brackets, so no markup can survive double-encoding.
 */
function stripMarkup(input: string): string {
  const lower = input.toLowerCase();
  const lastGt = input.lastIndexOf(">");
  let out = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch !== "<") {
      out += ch;
      i++;
      continue;
    }
    if (i > lastGt) {
      // No closing bracket anywhere after this point: drop the stray "<".
      i++;
      continue;
    }
    const isBlock =
      lower.startsWith("<script", i) || lower.startsWith("<style", i);
    if (isBlock) {
      const closeTag = lower.startsWith("<script", i) ? "</script" : "</style";
      const close = lower.indexOf(closeTag, i + 1);
      if (close < 0) return out; // unterminated block: drop the rest
      const end = input.indexOf(">", close);
      i = end < 0 ? input.length : end + 1;
    } else {
      i = input.indexOf(">", i) + 1;
    }
    out += " ";
  }
  return out;
}

/** Strip tags/entities/control chars, collapse whitespace, cap length. */
export function cleanText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  // Bound work before any processing: untrusted input can be ~MBs.
  let t = value.length > 20_000 ? value.slice(0, 20_000) : value;
  t = t.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m);
  t = stripMarkup(t);
  t = t.replace(/&(lt|gt);/g, " ").replace(/[<>]/g, " ");
  t = t.replace(CONTROL_CHARS, " ");
  t = t.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > maxChars ? t.slice(0, maxChars).trimEnd() : t;
}

export function cleanTitle(value: unknown): string | null {
  return cleanText(value, CRAWLER_LIMITS.maxTitleChars);
}

export function cleanShort(value: unknown): string | null {
  return cleanText(value, CRAWLER_LIMITS.maxShortChars);
}

export function cleanSummary(value: unknown): string | null {
  return cleanText(value, CRAWLER_LIMITS.maxSummaryChars);
}

/**
 * Accept only absolute https URLs without credentials; drop fragments only
 * when `keepHash` is false. Resolves relative values against `base`.
 */
export function cleanUrl(
  value: unknown,
  base?: string,
  keepHash = false,
): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > CRAWLER_LIMITS.maxUrlChars) return null;
  try {
    const u = base ? new URL(raw, base) : new URL(raw);
    if (u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    if (!keepHash) u.hash = "";
    const out = u.toString();
    return out.length > CRAWLER_LIMITS.maxUrlChars ? null : out;
  } catch {
    return null;
  }
}

export function cleanCoordinate(
  value: unknown,
  min: number,
  max: number,
): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return n >= min && n <= max ? n : null;
}
