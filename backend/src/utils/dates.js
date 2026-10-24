const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** "AAAA-MM-JJ" du jour dans le fuseau de l'école. */
export function todayIn(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** "AAAA-MM-JJ" → Date UTC minuit (colonne PostgreSQL DATE). */
export function toDbDate(iso) {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** Date (colonne DATE) → "AAAA-MM-JJ". */
export function fromDbDate(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso, days) {
  const d = toDbDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return fromDbDate(d);
}

export function daysBetween(isoA, isoB) {
  return Math.round((toDbDate(isoB) - toDbDate(isoA)) / 86_400_000);
}

/** "2026-10-24" → "24/10/2026" */
export function formatDateFr(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Horodatage lisible dans le fuseau de l'école : "24/10/2026 08:12:03". */
export function formatDateTimeFr(date, timeZone) {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

/** Année scolaire RDC (septembre → juillet) : "2026-2027". */
export function schoolYearOf(iso) {
  const [y, m] = iso.split('-').map(Number);
  return m >= 9 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

/** Décalage (minutes) du fuseau par rapport à UTC à un instant donné, ex : +120 pour Africa/Lubumbashi. */
export function timeZoneOffsetMinutes(timeZone, at) {
  const label = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(label ?? '');
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** Bornes [début, fin[ (instants UTC) de la journée civile "AAAA-MM-JJ" dans le fuseau de l'école. */
export function zonedDayRange(iso, timeZone) {
  const offset = timeZoneOffsetMinutes(timeZone, new Date(`${iso}T12:00:00.000Z`));
  const start = new Date(toDbDate(iso).getTime() - offset * 60_000);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}
