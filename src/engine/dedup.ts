/**
 * In-run dedup helpers (pure). Cross-run dedup is the receiver's job.
 */

export function normalizeTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Token Jaccard similarity on normalized titles, 0..1. */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeTitle(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeTitle(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export const SIMILARITY_THRESHOLD = 0.7;
export const SIMILARITY_WINDOW_DAYS = 3;

export function isSimilarTitleAndDate(
  a: { title: string; startDate: string },
  b: { title: string; startDate: string },
): boolean {
  const dt = Math.abs(Date.parse(a.startDate) - Date.parse(b.startDate));
  if (!Number.isFinite(dt) || dt > SIMILARITY_WINDOW_DAYS * 86_400_000) {
    return false;
  }
  return titleSimilarity(a.title, b.title) >= SIMILARITY_THRESHOLD;
}
