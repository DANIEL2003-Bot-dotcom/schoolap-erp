/* Utilitaires partagés : configuration, formatage FR / RDC et client HTTP de l'API. */

// VITE_API_URL vide ("") = même origine (proxy Vite en développement).
// En développement (npm run dev), l'API est jointe via le proxy Vite (/api → localhost:4000) : pas de souci CORS.
// En production, VITE_API_URL doit contenir l'URL publique de l'API (ex : https://schoolap-erp-api.onrender.com).
export const API_URL = (import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? '' : 'http://localhost:4000')).replace(/\/+$/, '');
export const SCHOOL_TZ = 'Africa/Lubumbashi';

export const OPERATORS = {
  MPESA: { name: 'M-Pesa', color: '#E60000', prefixes: ['81', '82', '83'] },
  ORANGE_MONEY: { name: 'Orange Money', color: '#FF7900', prefixes: ['80', '84', '85', '89'] },
  AIRTEL_MONEY: { name: 'Airtel Money', color: '#D6001C', prefixes: ['97', '98', '99'] },
};

/* ----------------------------------------------------------------- Formatage */

export function todayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SCHOOL_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86_400_000);
}
export function formatLongDate(iso) {
  const s = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
  return s.charAt(0).toUpperCase() + s.slice(1);
}
export function formatShortDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
export function formatTime(isoDateTime) {
  if (!isoDateTime) return '';
  return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: SCHOOL_TZ }).format(new Date(isoDateTime));
}
export function formatDateTime(isoDateTime) {
  if (!isoDateTime) return '';
  return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: SCHOOL_TZ }).format(new Date(isoDateTime));
}
export function formatPct(rate) {
  if (rate === null || rate === undefined) return '—';
  return `${(rate * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`;
}
export function formatMoney(amount, currency = 'USD') {
  const n = Number(amount) || 0;
  if (currency === 'CDF') return `${Math.round(n).toLocaleString('fr-FR')} FC`;
  return `${n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
}
export function formatPhone(e164) {
  const m = /^\+243(\d{2})(\d{3})(\d{4})$/.exec(e164 || '');
  return m ? `+243 ${m[1]} ${m[2]} ${m[3]}` : e164 || '—';
}
export function normalizePhone(input) {
  let d = String(input || '').replace(/[\s.\-()]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0') && d.length === 10) d = `243${d.slice(1)}`;
  const e164 = `+${d}`;
  return /^\+243[89]\d{8}$/.test(e164) ? e164 : null;
}
export function detectOperator(e164) {
  const prefix = (e164 || '').slice(4, 6);
  return Object.keys(OPERATORS).find((k) => OPERATORS[k].prefixes.includes(prefix)) || null;
}
export function initials(name) {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase();
}

/* ----------------------------------------------------------------- API réelle */

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function apiFetch(path, { token, method = 'GET', body, onSlow, timeoutMs = 75_000 } = {}) {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  // Une instance Render gratuite endormie met jusqu'à ~1 minute à se réveiller.
  const slowTimer = onSlow ? setTimeout(() => onSlow(true), 4000) : null;
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data.error || {};
      throw new ApiError(res.status, err.code || 'HTTP_ERROR', err.message || `Erreur HTTP ${res.status}`, err.details);
    }
    return data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err.name === 'AbortError') throw new ApiError(0, 'TIMEOUT', 'Le serveur ne répond pas. Vérifiez votre connexion puis réessayez.');
    throw new ApiError(0, 'NETWORK', `Serveur injoignable (${API_URL}). Vérifiez votre connexion Internet.`);
  } finally {
    clearTimeout(abortTimer);
    if (slowTimer) clearTimeout(slowTimer);
    if (onSlow) onSlow(false);
  }
}
