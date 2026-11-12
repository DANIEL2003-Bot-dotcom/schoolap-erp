/* =============================================================================
   Montant en toutes lettres (français, orthographe traditionnelle) pour les reçus :
   « Arrêté le présent reçu à la somme de : cinquante dollars américains ».
   ============================================================================= */

const UNITS = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize'];
const TENS = { 2: 'vingt', 3: 'trente', 4: 'quarante', 5: 'cinquante', 6: 'soixante' };

/** 0 à 99. `final` : le nombre termine le montant (« quatre-vingts ») ou précède « mille » (« quatre-vingt mille »). */
function below100(n, final) {
  if (n < 17) return UNITS[n];
  if (n < 20) return `dix-${UNITS[n - 10]}`;
  const t = Math.floor(n / 10);
  const u = n % 10;
  if (t === 7) return u === 1 ? 'soixante et onze' : `soixante-${below100(10 + u, true)}`;
  if (t === 8) return u === 0 ? (final ? 'quatre-vingts' : 'quatre-vingt') : `quatre-vingt-${UNITS[u]}`;
  if (t === 9) return `quatre-vingt-${below100(10 + u, true)}`;
  if (u === 0) return TENS[t];
  if (u === 1) return `${TENS[t]} et un`;
  return `${TENS[t]}-${UNITS[u]}`;
}

/** 0 à 999 (« deux cents », mais « deux cent un » et « deux cent mille »). */
function below1000(n, final) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h === 0) return below100(r, final);
  const hundred = h === 1 ? 'cent' : `${UNITS[h]} cent`;
  if (r === 0) return h > 1 && final ? `${hundred}s` : hundred;
  return `${hundred} ${below100(r, final)}`;
}

/** Entier positif (jusqu'à 999 999 999 999) en toutes lettres. */
export function integerToWordsFr(value) {
  const n = Math.floor(Math.abs(Number(value)));
  if (!Number.isFinite(n) || n > 999_999_999_999) throw new RangeError('Montant hors limites.');
  if (n === 0) return 'zéro';
  const billions = Math.floor(n / 1e9);
  const millions = Math.floor((n % 1e9) / 1e6);
  const thousands = Math.floor((n % 1e6) / 1e3);
  const rest = n % 1e3;
  const parts = [];
  if (billions) parts.push(`${below1000(billions, true)} milliard${billions > 1 ? 's' : ''}`);
  if (millions) parts.push(`${below1000(millions, true)} million${millions > 1 ? 's' : ''}`);
  if (thousands) parts.push(thousands === 1 ? 'mille' : `${below1000(thousands, false)} mille`);
  if (rest) parts.push(below1000(rest, true));
  return parts.join(' ');
}

const CURRENCY_WORDS = {
  USD: { one: 'dollar américain', many: 'dollars américains', subOne: 'cent', subMany: 'cents' },
  CDF: { one: 'franc congolais', many: 'francs congolais', subOne: 'centime', subMany: 'centimes' },
};

/** Ex. : (50, 'USD') → « cinquante dollars américains » ; (12.5, 'USD') → « douze dollars américains et cinquante cents ». */
export function amountToWordsFr(amount, currency = 'USD') {
  const words = CURRENCY_WORDS[currency] ?? CURRENCY_WORDS.USD;
  const cents = Math.round(Math.abs(Number(amount)) * 100);
  const whole = Math.floor(cents / 100);
  const sub = cents % 100;
  const subText = sub ? `${integerToWordsFr(sub)} ${sub > 1 ? words.subMany : words.subOne}` : '';
  if (whole === 0 && sub > 0) return subText;
  // « un million de francs », « deux milliards de dollars » : « de » après un nombre rond de millions ou de milliards.
  const roundBig = whole >= 1e6 && whole % 1e6 === 0;
  const unit = whole >= 2 ? words.many : words.one;
  const main = `${integerToWordsFr(whole)}${roundBig ? ' de' : ''} ${unit}`;
  return subText ? `${main} et ${subText}` : main;
}
