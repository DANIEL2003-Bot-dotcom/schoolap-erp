/**
 * Numéros mobiles RDC : +243 + 9 chiffres commençant par 8 ou 9.
 * Accepte "+243 970 000 000", "243970000000", "0970000000", "00243970000000".
 */
const DRC_MOBILE = /^\+243[89]\d{8}$/;

export function normalizeDrcPhone(input) {
  if (typeof input !== 'string') return null;
  let digits = input.trim().replace(/[\s.\-()]/g, '');
  if (!/^\+?\d+$/.test(digits)) return null;
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 10) digits = `243${digits.slice(1)}`;
  const e164 = `+${digits}`;
  return DRC_MOBILE.test(e164) ? e164 : null;
}

/** Préfixes réseau → opérateur Mobile Money. */
export const OPERATOR_PREFIXES = Object.freeze({
  MPESA: ['81', '82', '83'],
  ORANGE_MONEY: ['80', '84', '85', '89'],
  AIRTEL_MONEY: ['97', '98', '99'],
});

export function detectOperator(e164) {
  const prefix = e164?.slice(4, 6);
  return Object.keys(OPERATOR_PREFIXES).find((op) => OPERATOR_PREFIXES[op].includes(prefix)) ?? null;
}

export function maskPhone(e164) {
  if (typeof e164 !== 'string' || e164.length < 8) return '***';
  return `${e164.slice(0, 6)}${'*'.repeat(e164.length - 8)}${e164.slice(-2)}`;
}

export function formatPhone(e164) {
  const m = /^\+243(\d{2})(\d{3})(\d{4})$/.exec(e164 ?? '');
  return m ? `+243 ${m[1]} ${m[2]} ${m[3]}` : e164;
}
