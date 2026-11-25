/**
 * Interpret a datetime-local string (no timezone) as Europe/Bratislava
 * wall-clock time and return an ISO 8601 UTC string for Postgres timestamptz.
 *
 * datetime-local gives us e.g. "2026-06-15T09:00" — no offset info.
 * We need to figure out whether Bratislava is at +01:00 (CET) or +02:00 (CEST)
 * for that specific date, then convert to UTC.
 */
export function datetimeLocalToUtc(value: string): string {
  const [datePart, timePart] = value.split("T");
  if (!datePart || !timePart) return value;

  const [y, m, d] = datePart.split("-").map(Number) as [number, number, number];
  const [h, min] = timePart.split(":").map(Number) as [number, number];

  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Bratislava",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  // Try both possible offsets for Europe/Bratislava: +1 (CET) and +2 (CEST)
  for (const offsetH of [1, 2]) {
    const candidate = new Date(Date.UTC(y, m - 1, d, h - offsetH, min));
    const parts = Object.fromEntries(
      fmt.formatToParts(candidate).map((p) => [p.type, p.value]),
    );
    if (
      Number(parts.year) === y &&
      Number(parts.month) === m &&
      Number(parts.day) === d &&
      Number(parts.hour) === h &&
      Number(parts.minute) === min
    ) {
      return candidate.toISOString();
    }
  }

  // Fallback: treat as UTC (should never happen for valid SK/CZ dates)
  return new Date(Date.UTC(y, m - 1, d, h, min)).toISOString();
}
