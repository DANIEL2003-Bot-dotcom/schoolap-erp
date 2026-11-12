import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { OPERATORS, SCHOOL_TZ, apiFetch, detectOperator, formatMoney, formatPhone, formatShortDate, formatTime, normalizePhone, todayIso } from './lib.js';
import { Field, Modal, fieldErrors, useAsync } from './ui.jsx';

/* =============================================================================
   Caisse — bureau de la Comptabilité
   - Encaissement manuel : espèces, dépôt bancaire (bordereau), Mobile Money reçu
     sur le téléphone de l'école ; reçu numéroté émis aussitôt.
   - Impression du reçu au choix : A4 en deux exemplaires (souche + parent) ou
     ticket 80 mm ; à partir de la 2e impression, mention « DUPLICATA ».
   - Journal de caisse (jour ou période) imprimable pour la clôture.
   - Annulation d'un reçu par la direction (motif obligatoire).
   ============================================================================= */

export const PAYMENT_METHODS = {
  CASH: { label: 'Espèces', short: 'Espèces' },
  BANK: { label: 'Dépôt bancaire', short: 'Banque' },
  MOBILE_MONEY_DIRECT: { label: 'Mobile Money (téléphone de l’école)', short: 'Mobile Money' },
  MOBILE_MONEY: { label: 'Mobile Money (demande en ligne)', short: 'En ligne' },
};
const BANKS = ['Rawbank', 'Equity BCDC', 'TMB (Trust Merchant Bank)', 'Ecobank', 'Access Bank', 'FirstBank', 'Afriland First Bank', 'Sofibanque', 'Solidaire Banque', 'UBA', 'BOA'];

export const FINANCE_CSS = `
#collect-form,#collect-form .field{min-width:0;max-width:100%}
#collect-form select,#collect-form input{width:100%;max-width:100%;min-width:0;box-sizing:border-box;text-overflow:ellipsis}
.method-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px}
.method{border:2px solid var(--grey-200);border-radius:10px;padding:10px 6px;background:#fff;font-weight:700;font-size:13px;display:flex;flex-direction:column;align-items:center;gap:4px;color:var(--navy-900)}
.method small{font-weight:500;color:var(--grey-500);font-size:11px}
.method[aria-pressed=true]{border-color:var(--navy-700);background:var(--navy-100)}
.pick-list{list-style:none;margin:0 0 12px;padding:0;border:1px solid var(--grey-200);border-radius:10px;max-height:300px;overflow:auto}
.pick-list li+li{border-top:1px solid var(--grey-100)}
.pick-list button{width:100%;text-align:left;background:#fff;border:0;padding:10px 12px;display:flex;justify-content:space-between;gap:10px;align-items:center}
.pick-list button:hover,.pick-list button[aria-pressed=true]{background:var(--navy-100)}
.pick-list b{display:block;color:var(--navy-900)}
.pick-list small{color:var(--grey-500)}
.pay-head{background:var(--grey-50);border-radius:10px;padding:10px 12px;margin-bottom:14px}
.pay-head b{display:block;color:var(--navy-900)}
.pay-head small{color:var(--grey-500)}
.receipt-preview{border:1px solid var(--grey-200);border-radius:10px;padding:10px;background:#fff;margin-bottom:12px;overflow:auto}
.print-actions{display:flex;flex-wrap:wrap;gap:8px}
.print-actions .btn{flex:1 1 180px}
.cash-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.cash-row.cancelled td{color:var(--grey-500);text-decoration:line-through}
.cash-row.cancelled td.c-act,.cash-row.cancelled td.c-status{text-decoration:none}
.cancel-box{border:1px solid #F5C2C2;background:var(--red-50);border-radius:10px;padding:12px;margin-top:12px}
.cancel-box textarea{width:100%;min-height:70px;border:1px solid var(--grey-300);border-radius:8px;padding:8px;font:inherit;margin:6px 0}
/* --- Reçu (aperçu écran et impression) --- */
.rc{position:relative;font:12px/1.4 Arial,Helvetica,sans-serif;color:#111;padding:6mm 7mm;box-sizing:border-box;overflow:hidden}
.rc-head{display:flex;justify-content:space-between;gap:10px;border-bottom:2px solid #0B2545;padding-bottom:6px;margin-bottom:8px}
.rc-school b{display:block;font-size:15px;color:#0B2545;text-transform:uppercase}
.rc-school span{display:block;font-size:11px;color:#333}
.rc-title{text-align:right}
.rc-title span{display:block;font-weight:700;font-size:13px;letter-spacing:.5px}
.rc-title b{display:block;font-size:15px;color:#0B2545}
.rc-title small{display:block;font-size:10px;color:#555;font-style:italic}
.rc-grid{width:100%;border-collapse:collapse;margin-bottom:8px}
.rc-grid th{text-align:left;font-weight:600;color:#444;width:32%;padding:2px 6px 2px 0;vertical-align:top}
.rc-grid td{padding:2px 0;font-weight:600}
.rc-amount{display:flex;justify-content:space-between;align-items:center;border:2px solid #0B2545;border-radius:6px;padding:6px 10px;margin:6px 0}
.rc-amount span{font-weight:700;text-transform:uppercase;font-size:11px}
.rc-amount b{font-size:20px;color:#0B2545}
.rc-words{margin:4px 0 6px}
.rc-balance{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:6px 0;text-align:center}
.rc-balance div{border:1px solid #bbb;border-radius:4px;padding:3px}
.rc-balance small{display:block;font-size:10px;color:#555}
.rc-note{margin:4px 0;font-style:italic}
.rc-sign{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:10px}
.rc-sign div{font-size:11px;color:#333}
.rc-sign b{display:block;color:#111}
.rc-line{display:block;border-bottom:1px solid #333;height:22px;margin-top:4px}
.rc-box{display:block;border:1px dashed #888;height:34px;margin-top:4px;border-radius:4px}
.rc-foot{margin:8px 0 0;font-size:9.5px;color:#555;text-align:center}
.rc-dup{position:absolute;top:44%;left:50%;transform:translate(-50%,-50%) rotate(-18deg);font-size:46px;font-weight:800;color:rgba(29,78,137,.13);letter-spacing:6px;pointer-events:none}
.rc-stamp{position:absolute;top:40%;left:50%;transform:translate(-50%,-50%) rotate(-18deg);font-size:58px;font-weight:900;color:rgba(200,30,30,.28);border:6px solid rgba(200,30,30,.28);padding:0 18px;border-radius:10px;pointer-events:none}
.rc-cancel{color:#B00020;font-weight:700;margin:4px 0}
.rc-a4 .rc{height:138mm}
.rc-cut{border-top:1px dashed #666;text-align:center;font-size:10px;color:#666;margin:0;line-height:0}
.rc-cut span{background:#fff;padding:0 8px;position:relative;top:0}
.ticket{width:72mm;font:11.5px/1.35 'Courier New',Courier,monospace;color:#000;padding:2mm 1mm;position:relative}
.ticket .t-c{text-align:center}
.ticket .t-b{font-weight:700}
.ticket .t-big{font-size:16px;font-weight:700}
.ticket hr{border:0;border-top:1px dashed #000;margin:4px 0}
.ticket .t-row{display:flex;justify-content:space-between;gap:6px}
.ticket .t-row span:last-child{text-align:right}
.ticket .t-sign{border-bottom:1px solid #000;height:24px;margin:4px 0}
.journal{font:11px/1.35 Arial,Helvetica,sans-serif;color:#111}
.journal h1{font-size:16px;margin:4px 0 2px;color:#0B2545}
.journal table{width:100%;border-collapse:collapse;margin:8px 0}
.journal th,.journal td{border:1px solid #999;padding:3px 4px;text-align:left}
.journal th{background:#E6EDF7}
.journal td.n{text-align:right;white-space:nowrap}
.journal tr.x td{color:#777;text-decoration:line-through}
.journal .j-sum{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:8px 0}
.journal .j-sum div{border:1px solid #999;border-radius:4px;padding:6px}
#print-root{position:absolute;left:-10000px;top:0;width:auto;background:#fff}
@media print{
  body.printing>*:not(#print-root){display:none!important}
  body.printing #print-root{position:static;left:auto}
  body.printing{background:#fff!important}
  .rc,.ticket,.journal{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
@media (max-width:720px){
  .method-grid{grid-template-columns:1fr 1fr 1fr}
  .receipt-preview .rc{transform-origin:top left}
}
`;

/* ------------------------------------------------------------------ API */

const qs = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();

export function createFinanceApi(token, onSlow) {
  const call = (path, method = 'GET', body) => apiFetch(`/api/finance${path}`, { token, method, body, onSlow });
  return {
    record: (b) => call('/payments', 'POST', b),
    journal: (params) => call(`/payments?${qs(params)}`),
    summary: (date) => call(`/summary?${qs({ date })}`),
    receipt: (id) => call(`/receipts/${id}`),
    printed: (id) => call(`/receipts/${id}/printed`, 'POST', {}),
    cancel: (id, reason) => call(`/payments/${id}/cancel`, 'POST', { reason }),
    searchStudents: (q) => apiFetch(`/api/admin/students?${qs({ q, pageSize: 8, status: 'all' })}`, { token, onSlow }),
    student: (id) => apiFetch(`/api/admin/students/${id}`, { token, onSlow }),
  };
}

/** Identifiant unique d'une demande d'encaissement (anti-doublon en cas de double clic ou de réseau instable). */
function newRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ------------------------------------------------------------ Formatage */

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const provinceLabel = (p) => (p ? p.split('_').map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join('-') : '');
function formatReceiptDate(iso) {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: SCHOOL_TZ }).format(d);
  return `${day} à ${formatTime(iso)}`;
}
const parseAmount = (v) => Number(String(v).replace(/\s/g, '').replace(',', '.'));

/* ------------------------------------------------------------ Impression */

let printContainer = null;
let printRoot = null;

/**
 * Imprime un document React (reçu ou journal) : rendu dans un conteneur dédié, hors écran,
 * puis window.print(). Seul ce conteneur est imprimé (le reste de la page est masqué à l'impression).
 * Ticket 80 mm : la hauteur de page est ajustée au contenu pour ne pas dérouler de papier blanc.
 */
export function printDocument(node, format) {
  if (!printContainer) {
    printContainer = document.createElement('div');
    printContainer.id = 'print-root';
    printContainer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(printContainer);
    printRoot = createRoot(printContainer);
  }
  flushSync(() => printRoot.render(node));
  let pageCss = '@page{size:A4 portrait;margin:8mm}';
  if (format === 'ticket') {
    const el = printContainer.firstElementChild;
    const heightMm = el ? Math.ceil((el.getBoundingClientRect().height * 25.4) / 96) + 8 : 200;
    pageCss = `@page{size:80mm ${heightMm}mm;margin:2mm 4mm}`;
  }
  let style = document.getElementById('print-page-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'print-page-style';
    document.head.appendChild(style);
  }
  style.textContent = pageCss;
  document.body.classList.add('printing');
  const done = () => {
    window.removeEventListener('afterprint', done);
    setTimeout(() => document.body.classList.remove('printing'), 500);
  };
  window.addEventListener('afterprint', done);
  window.print();
}

/** Enregistre l'impression côté serveur (DUPLICATA dès la 2e), puis imprime au format choisi. */
export async function printReceipt(api, receipt, format, notify) {
  let duplicate = receipt.printCount > 0;
  try {
    const res = await api.printed(receipt.id);
    duplicate = res.duplicate;
  } catch (err) {
    if (notify && err.status !== 0) notify({ error: true, text: err.message });
  }
  printDocument(format === 'ticket' ? <ReceiptTicket r={receipt} duplicate={duplicate} /> : <ReceiptA4 r={receipt} duplicate={duplicate} />, format);
  return duplicate;
}

/* ------------------------------------------------------------ Documents */

function ReceiptCopy({ r, copyLabel, duplicate }) {
  const cancelled = r.status === 'CANCELLED';
  return (
    <div className="rc">
      {duplicate && !cancelled && <div className="rc-dup">DUPLICATA</div>}
      {cancelled && <div className="rc-stamp">ANNULÉ</div>}
      <div className="rc-head">
        <div className="rc-school">
          <b>{r.school.name}</b>
          <span>
            Code EPST {r.school.epstCode}
            {r.school.city ? ` · ${r.school.city}` : ''}
            {r.school.province ? ` · ${provinceLabel(r.school.province)}` : ''}
          </span>
          {r.school.phone && <span>Tél. {formatPhone(r.school.phone)}</span>}
          <span>Comptabilité / Caisse</span>
        </div>
        <div className="rc-title">
          <span>REÇU DE PAIEMENT</span>
          <b>N° {r.receiptNumber}</b>
          {copyLabel && <small>{copyLabel}</small>}
          {duplicate && !cancelled && <small>Duplicata</small>}
        </div>
      </div>
      <table className="rc-grid">
        <tbody>
          <tr>
            <th>Date</th>
            <td>{formatReceiptDate(r.paidAt)}</td>
          </tr>
          <tr>
            <th>Élève</th>
            <td>
              {r.student.fullName} · Matricule {r.student.matricule}
            </td>
          </tr>
          <tr>
            <th>Classe</th>
            <td>
              {r.student.className ?? '—'} · Année scolaire {r.fee.schoolYear}
            </td>
          </tr>
          <tr>
            <th>Objet</th>
            <td>{r.fee.label}</td>
          </tr>
          <tr>
            <th>Mode de paiement</th>
            <td>{r.methodDetails}</td>
          </tr>
          {(r.payerName || r.payerPhone) && (
            <tr>
              <th>Versé par</th>
              <td>
                {r.payerName ?? ''}
                {r.payerName && r.payerPhone ? ' · ' : ''}
                {r.payerPhone ? formatPhone(r.payerPhone) : ''}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="rc-amount">
        <span>Montant reçu</span>
        <b>{formatMoney(r.amount, r.currency)}</b>
      </div>
      <p className="rc-words">
        Arrêté le présent reçu à la somme de : <b>{capitalize(r.amountInWords)}</b>.
      </p>
      <div className="rc-balance">
        <div>
          <small>Montant du frais</small>
          {formatMoney(r.fee.amountDue, r.currency)}
        </div>
        <div>
          <small>Total payé (ce reçu inclus)</small>
          {formatMoney(r.fee.amountDue - r.fee.balanceAfter, r.currency)}
        </div>
        <div>
          <small>Reste à payer</small>
          <b>{formatMoney(r.fee.balanceAfter, r.currency)}</b>
        </div>
      </div>
      {r.note && <p className="rc-note">Remarque : {r.note}</p>}
      {r.cancelled && (
        <p className="rc-cancel">
          Reçu annulé {r.cancelled.at ? `le ${formatReceiptDate(r.cancelled.at)}` : ''} par {r.cancelled.by ?? 'la direction'} — motif : {r.cancelled.reason}
        </p>
      )}
      <div className="rc-sign">
        <div>
          Le caissier
          <b>
            {r.cashier.name}
            {r.cashier.role ? ` (${r.cashier.role})` : ''}
          </b>
          <span className="rc-line" />
        </div>
        <div>
          Cachet de l’école
          <span className="rc-box" />
        </div>
      </div>
      <p className="rc-foot">Ce reçu fait foi de paiement : conservez-le. Réf. interne {r.transactionId}.</p>
    </div>
  );
}

/** A4 : souche (exemplaire de l'école) + exemplaire du parent, séparés par une ligne de découpe. */
export function ReceiptA4({ r, duplicate }) {
  return (
    <div className="rc-a4">
      <ReceiptCopy r={r} copyLabel="Souche — exemplaire de l’école" duplicate={duplicate} />
      <p className="rc-cut">
        <span>✂ Découper ici</span>
      </p>
      <ReceiptCopy r={r} copyLabel="Exemplaire du parent" duplicate={duplicate} />
    </div>
  );
}

/** Ticket 80 mm pour imprimante thermique. */
export function ReceiptTicket({ r, duplicate }) {
  const cancelled = r.status === 'CANCELLED';
  const row = (k, v) => (
    <div className="t-row">
      <span>{k}</span>
      <span>{v}</span>
    </div>
  );
  return (
    <div className="ticket">
      <div className="t-c t-b">{r.school.name.toUpperCase()}</div>
      <div className="t-c">
        EPST {r.school.epstCode}
        {r.school.city ? ` · ${r.school.city}` : ''}
      </div>
      {r.school.phone && <div className="t-c">Tél. {formatPhone(r.school.phone)}</div>}
      <hr />
      <div className="t-c t-b">REÇU DE PAIEMENT</div>
      <div className="t-c t-b">N° {r.receiptNumber}</div>
      {duplicate && !cancelled && <div className="t-c t-b">*** DUPLICATA ***</div>}
      {cancelled && <div className="t-c t-b">*** REÇU ANNULÉ ***</div>}
      <hr />
      {row('Date', formatReceiptDate(r.paidAt))}
      <div className="t-b">{r.student.fullName}</div>
      {row('Matricule', r.student.matricule)}
      {row('Classe', r.student.className ?? '—')}
      {row('Objet', r.fee.label)}
      <div>Mode : {r.methodDetails}</div>
      {r.payerName && <div>Versé par : {r.payerName}</div>}
      <hr />
      <div className="t-row t-big">
        <span>MONTANT</span>
        <span>{formatMoney(r.amount, r.currency)}</span>
      </div>
      <div>{capitalize(r.amountInWords)}.</div>
      <hr />
      {row('Montant du frais', formatMoney(r.fee.amountDue, r.currency))}
      {row('Total payé', formatMoney(r.fee.amountDue - r.fee.balanceAfter, r.currency))}
      <div className="t-row t-b">
        <span>Reste à payer</span>
        <span>{formatMoney(r.fee.balanceAfter, r.currency)}</span>
      </div>
      {r.note && <div>Remarque : {r.note}</div>}
      {r.cancelled && <div className="t-b">Annulé : {r.cancelled.reason}</div>}
      <hr />
      <div>Caissier : {r.cashier.name}</div>
      <div className="t-sign" />
      <div className="t-c">Signature et cachet</div>
      <hr />
      <div className="t-c">Ce reçu fait foi de paiement.</div>
      <div className="t-c">{r.transactionId}</div>
    </div>
  );
}

function JournalDocument({ j, filterLabel }) {
  const title = j.from === j.to ? `du ${formatShortDate(j.from)}` : `du ${formatShortDate(j.from)} au ${formatShortDate(j.to)}`;
  return (
    <div className="journal">
      <div className="rc-head" style={{ display: 'flex' }}>
        <div className="rc-school">
          <b>{j.school.name}</b>
          <span>
            Code EPST {j.school.epstCode}
            {j.school.city ? ` · ${j.school.city}` : ''}
          </span>
        </div>
        <div className="rc-title">
          <span>Comptabilité / Caisse</span>
          <small>Édité le {formatReceiptDate(j.generatedAt)}</small>
        </div>
      </div>
      <h1>JOURNAL DE CAISSE {title.toUpperCase()}</h1>
      {filterLabel && <div>Filtre : {filterLabel}</div>}
      <div className="j-sum">
        <div>
          <b>Total encaissé</b>
          <br />
          {j.totals.length ? j.totals.map((t) => formatMoney(t.total, t.currency)).join(' · ') : '—'}
          <br />
          {j.count} reçu(s){j.cancelledCount ? ` · ${j.cancelledCount} annulé(s)` : ''}
        </div>
        <div>
          <b>Par mode</b>
          {j.byMethod.map((m) => (
            <div key={m.method}>
              {m.label} ({m.count}) : {Object.entries(m.totals).map(([c, v]) => formatMoney(v, c)).join(' · ')}
            </div>
          ))}
        </div>
        <div>
          <b>Par caissier</b>
          {j.byCashier.map((c) => (
            <div key={c.cashier}>
              {c.cashier} ({c.count}) : {Object.entries(c.totals).map(([cur, v]) => formatMoney(v, cur)).join(' · ')}
            </div>
          ))}
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>N° reçu</th>
            <th>Date</th>
            <th>Élève</th>
            <th>Classe</th>
            <th>Frais</th>
            <th>Mode</th>
            <th>Caissier</th>
            <th>Montant</th>
          </tr>
        </thead>
        <tbody>
          {j.payments.map((p) => (
            <tr key={p.id} className={p.status === 'CANCELLED' ? 'x' : ''}>
              <td>{p.receiptNumber ?? '—'}</td>
              <td>
                {j.from === j.to ? '' : `${formatShortDate(new Intl.DateTimeFormat('en-CA', { timeZone: SCHOOL_TZ }).format(new Date(p.paidAt)))} `}
                {formatTime(p.paidAt)}
              </td>
              <td>{p.studentName}</td>
              <td>{p.className}</td>
              <td>{p.feeLabel}</td>
              <td>{p.methodDetails}</td>
              <td>{p.cashier ?? '—'}</td>
              <td className="n">
                {formatMoney(p.amount, p.currency)}
                {p.status === 'CANCELLED' ? ' (annulé)' : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="rc-sign">
        <div>
          Le caissier
          <span className="rc-line" />
        </div>
        <div>
          Le chef d’établissement (visa)
          <span className="rc-line" />
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------- Reçu à l'écran */

function PrintButtons({ api, receipt, notify, onPrinted }) {
  const [busy, setBusy] = useState('');
  async function go(format) {
    setBusy(format);
    try {
      const duplicate = await printReceipt(api, receipt, format, notify);
      onPrinted?.(duplicate);
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="print-actions">
      <button type="button" className="btn btn-primary" onClick={() => go('a4')} disabled={Boolean(busy)}>
        {busy === 'a4' ? <span className="spinner" /> : '🖨'} Imprimer A4 (2 exemplaires)
      </button>
      <button type="button" className="btn btn-ghost" onClick={() => go('ticket')} disabled={Boolean(busy)}>
        {busy === 'ticket' ? <span className="spinner" /> : '🧾'} Ticket 80 mm
      </button>
    </div>
  );
}

/** Fenêtre d'un reçu existant : aperçu, impression (duplicata) et annulation par la direction. */
export function ReceiptModal({ api, receiptId, canCancel, onClose, onChanged, notify, onLogout }) {
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, run] = useAsync(notify, onLogout);

  useEffect(() => {
    api
      .receipt(receiptId)
      .then((d) => setReceipt(d.receipt))
      .catch((err) => (err.status === 401 ? onLogout('Votre session a expiré. Reconnectez-vous.') : setError(err.message)));
  }, [api, receiptId, onLogout]);

  async function cancel() {
    if (reason.trim().length < 5) return notify({ error: true, text: 'Indiquez le motif de l’annulation (5 caractères minimum).' });
    const res = await run(() => api.cancel(receiptId, reason.trim()), { success: (r) => `Reçu n° ${r.receipt.receiptNumber} annulé. Le tuteur est prévenu par SMS.` });
    if (res) {
      setReceipt(res.receipt);
      setCancelOpen(false);
      onChanged?.();
    }
  }

  return (
    <Modal
      wide
      title={receipt ? `Reçu n° ${receipt.receiptNumber}` : 'Reçu'}
      onClose={onClose}
      footer={
        <button className="btn btn-ghost" onClick={onClose}>
          Fermer
        </button>
      }
    >
      {error && <div className="alert alert-error">{error}</div>}
      {!receipt && !error && <div className="skeleton" style={{ height: 220 }} />}
      {receipt && (
        <>
          {receipt.status === 'CANCELLED' && (
            <div className="alert alert-error">
              Reçu annulé par {receipt.cancelled?.by ?? 'la direction'} — motif : {receipt.cancelled?.reason}
            </div>
          )}
          {receipt.printCount > 0 && receipt.status !== 'CANCELLED' && (
            <div className="alert alert-info">Déjà imprimé {receipt.printCount} fois : une nouvelle impression portera la mention « DUPLICATA ».</div>
          )}
          <div className="receipt-preview">
            <ReceiptCopy r={receipt} copyLabel="Aperçu" duplicate={receipt.printCount > 0} />
          </div>
          <PrintButtons api={api} receipt={receipt} notify={notify} onPrinted={() => setReceipt((r) => ({ ...r, printCount: r.printCount + 1 }))} />
          {canCancel && receipt.status === 'SUCCESS' && (
            <div style={{ marginTop: 14 }}>
              {!cancelOpen ? (
                <button type="button" className="link" onClick={() => setCancelOpen(true)}>
                  Annuler ce reçu (erreur de saisie)…
                </button>
              ) : (
                <div className="cancel-box">
                  <b>Annuler le reçu n° {receipt.receiptNumber}</b>
                  <div className="hint">
                    Le montant de {formatMoney(receipt.amount, receipt.currency)} sera retiré du frais « {receipt.fee.label} ». Le reçu reste dans le journal, barré « ANNULÉ », et le
                    tuteur est prévenu par SMS.
                  </div>
                  <label htmlFor="cancel-reason" className="sr-only">
                    Motif
                  </label>
                  <textarea id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motif (ex : montant mal saisi, 50 $ au lieu de 5 $)" maxLength={300} />
                  <div className="actions">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCancelOpen(false)} disabled={busy}>
                      Retour
                    </button>
                    <button type="button" className="btn btn-danger btn-sm" onClick={cancel} disabled={busy}>
                      {busy ? <span className="spinner" /> : null} Confirmer l’annulation
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------- Encaissement */

/**
 * Encaissement manuel. `initial` (facultatif) : { student, fee } pour encaisser directement un frais
 * (depuis la liste des insolvables ou la fiche élève) ; sinon recherche de l'élève puis choix du frais.
 * `onMobileMoney(fee)` (facultatif) : bascule vers la demande Mobile Money envoyée au téléphone du parent.
 */
export function CollectModal({ api, initial = null, onClose, onDone, notify, onLogout, onMobileMoney }) {
  const [student, setStudent] = useState(initial?.student ?? null);
  const [fees, setFees] = useState(initial?.fee ? [initial.fee] : null);
  const [feeId, setFeeId] = useState(initial?.fee?.id ?? '');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [form, setForm] = useState({ amount: initial?.fee ? String(initial.fee.remaining) : '', method: 'CASH', bankName: '', externalRef: '', operator: 'MPESA', payerPhone: '', payerName: '', note: '' });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [smsInfo, setSmsInfo] = useState(null);
  const [busy, run] = useAsync(notify, onLogout);
  const requestId = useRef(newRequestId());
  const searchSeq = useRef(0);

  const fee = fees?.find((f) => f.id === feeId) ?? null;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  // Recherche d'élève (nom, postnom, matricule ou téléphone du tuteur), avec délai de frappe.
  useEffect(() => {
    if (student) return undefined;
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return undefined;
    }
    const seq = ++searchSeq.current;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await api.searchStudents(q);
        if (seq === searchSeq.current) setResults(res.students);
      } catch (err) {
        if (err.status === 401) onLogout('Votre session a expiré. Reconnectez-vous.');
        else if (seq === searchSeq.current) setError(err.message);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [api, query, student, onLogout]);

  async function chooseStudent(s) {
    setError('');
    const detail = await run(() => api.student(s.id));
    if (!detail) return;
    const open = detail.fees.filter((f) => f.remaining > 0);
    setStudent({ id: s.id, fullName: s.fullName, matricule: s.matricule, className: s.className, guardianPhone: s.guardianPhone, isActive: s.isActive });
    setFees(open);
    if (open.length) {
      setFeeId(open[0].id);
      setForm((f) => ({ ...f, amount: String(open[0].remaining) }));
    }
  }

  function chooseFee(id) {
    setFeeId(id);
    const f = fees.find((x) => x.id === id);
    if (f) setForm((x) => ({ ...x, amount: String(f.remaining) }));
  }

  function onPayerPhone(value) {
    setForm((f) => {
      const e164 = normalizePhone(value);
      const op = e164 && detectOperator(e164);
      return { ...f, payerPhone: value, operator: op || f.operator };
    });
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    const amount = parseAmount(form.amount);
    const local = {};
    if (!fee) local.fee = 'Choisissez le frais à payer.';
    if (!Number.isFinite(amount) || amount <= 0) local.amount = 'Montant invalide.';
    else if (fee && amount > fee.remaining + 1e-9) local.amount = `Maximum : ${formatMoney(fee.remaining, fee.currency)}.`;
    if (form.method === 'BANK' && !form.bankName.trim()) local.bankName = 'Indiquez la banque.';
    if (form.method !== 'CASH' && !form.externalRef.trim()) local.externalRef = form.method === 'BANK' ? 'Numéro du bordereau obligatoire.' : 'Référence de la transaction obligatoire.';
    if (form.payerPhone.trim() && !normalizePhone(form.payerPhone)) local.payerPhone = 'Numéro invalide (ex : 0810000000).';
    setErrors(local);
    if (Object.keys(local).length) return;

    const body = {
      clientRequestId: requestId.current,
      schoolFeeId: fee.id,
      amount: Math.round(amount * 100) / 100,
      method: form.method,
      payerName: form.payerName.trim() || null,
      payerPhone: form.payerPhone.trim() ? normalizePhone(form.payerPhone) : null,
      note: form.note.trim() || null,
      ...(form.method === 'BANK' ? { bankName: form.bankName.trim(), externalRef: form.externalRef.trim() } : {}),
      ...(form.method === 'MOBILE_MONEY_DIRECT' ? { operator: form.operator, externalRef: form.externalRef.trim() } : {}),
    };
    const res = await run(() => api.record(body), {
      onError: (err) => {
        setErrors(fieldErrors(err));
        setError(err.message);
      },
    });
    if (!res) return;
    setReceipt(res.receipt);
    setSmsInfo(res.sms);
    notify({ text: `Reçu n° ${res.receipt.receiptNumber} : ${formatMoney(res.receipt.amount, res.receipt.currency)} encaissés pour ${res.receipt.student.fullName}.` });
    onDone?.(res.receipt);
  }

  function another() {
    requestId.current = newRequestId();
    setReceipt(null);
    setSmsInfo(null);
    setErrors({});
    setError('');
    setForm((f) => ({ ...f, amount: '', bankName: '', externalRef: '', payerPhone: '', payerName: '', note: '', method: 'CASH' }));
    if (initial?.fee) {
      onClose();
      return;
    }
    setStudent(null);
    setFees(null);
    setFeeId('');
    setQuery('');
    setResults(null);
  }

  const methodButton = (key, label, sub) => (
    <button type="button" key={key} className="method" aria-pressed={form.method === key} onClick={() => setForm((f) => ({ ...f, method: key }))}>
      {label}
      <small>{sub}</small>
    </button>
  );

  if (receipt) {
    return (
      <Modal
        wide
        title={`Reçu n° ${receipt.receiptNumber}`}
        onClose={onClose}
        footer={
          <>
            <button className="btn btn-ghost" onClick={another}>
              {initial?.fee ? 'Terminer' : '+ Nouvel encaissement'}
            </button>
            <button className="btn btn-primary" onClick={onClose}>
              Fermer
            </button>
          </>
        }
      >
        <div className="alert alert-info" role="status">
          ✓ Paiement enregistré : <b>{formatMoney(receipt.amount, receipt.currency)}</b> pour {receipt.student.fullName}. Reste à payer sur « {receipt.fee.label} » :{' '}
          <b>{formatMoney(receipt.fee.balanceAfter, receipt.currency)}</b>.
          {smsInfo?.status === 'sent' && <> Le tuteur a reçu un SMS de confirmation.</>}
        </div>
        <div className="receipt-preview">
          <ReceiptCopy r={receipt} copyLabel="Aperçu" duplicate={false} />
        </div>
        <PrintButtons api={api} receipt={receipt} notify={notify} onPrinted={() => setReceipt((r) => ({ ...r, printCount: r.printCount + 1 }))} />
      </Modal>
    );
  }

  return (
    <Modal
      wide
      title="Encaisser un paiement"
      onClose={busy ? () => {} : onClose}
      footer={
        student && (
          <>
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Annuler
            </button>
            <button type="submit" form="collect-form" className="btn btn-primary" disabled={busy || !fee}>
              {busy ? <span className="spinner" /> : null} Enregistrer et émettre le reçu
            </button>
          </>
        )
      }
    >
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      {!student ? (
        <>
          <Field id="collect-search" label="Élève" hint="Nom, postnom, prénom, matricule ou téléphone du tuteur">
            <input id="collect-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher un élève…" autoFocus autoComplete="off" />
          </Field>
          {searching && <div className="skeleton" style={{ height: 60 }} />}
          {results && !searching && results.length === 0 && <div className="empty">Aucun élève trouvé.</div>}
          {results && results.length > 0 && (
            <ul className="pick-list">
              {results.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => chooseStudent(s)} disabled={busy}>
                    <span>
                      <b>{s.fullName}</b>
                      <small>
                        {s.matricule} · {s.className}
                        {!s.isActive ? ' · désinscrit' : ''}
                      </small>
                    </span>
                    <small>{s.outstanding > 0 ? `Reste ${formatMoney(s.outstanding)}` : 'À jour'}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <form id="collect-form" onSubmit={submit} noValidate>
          <div className="pay-head">
            <b>{student.fullName}</b>
            <small>
              {student.matricule} · {student.className}
            </small>
            {!initial?.student && (
              <div>
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setStudent(null);
                    setFees(null);
                    setFeeId('');
                  }}
                >
                  Changer d’élève
                </button>
              </div>
            )}
          </div>

          {fees && fees.length === 0 ? (
            <div className="empty">
              <strong>Aucun frais à payer</strong>Tous les frais de cet élève sont soldés.
            </div>
          ) : initial?.fee ? (
            <div className="pay-head">
              <b>{fee.label}</b>
              <small>
                Payé {formatMoney(fee.amountPaid, fee.currency)} sur {formatMoney(fee.amountDue, fee.currency)} · reste <span className="remaining">{formatMoney(fee.remaining, fee.currency)}</span>
              </small>
            </div>
          ) : (
            <Field id="collect-fee" label="Frais à payer" error={errors.fee}>
              <select id="collect-fee" value={feeId} onChange={(e) => chooseFee(e.target.value)}>
                {fees?.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label} ({f.schoolYear}) — reste {formatMoney(f.remaining, f.currency)}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {fee && (
            <>
              <div className="method-grid" role="group" aria-label="Mode de paiement">
                {methodButton('CASH', 'Espèces', 'à la caisse')}
                {methodButton('BANK', 'Banque', 'bordereau')}
                {methodButton('MOBILE_MONEY_DIRECT', 'Mobile Money', 'reçu sur le tél. de l’école')}
              </div>

              <div className="form-grid">
                <Field id="collect-amount" label={`Montant reçu (${fee.currency})`} error={errors.amount} hint={`Reste à payer : ${formatMoney(fee.remaining, fee.currency)}`}>
                  <input id="collect-amount" inputMode="decimal" value={form.amount} onChange={set('amount')} className={errors.amount ? 'invalid' : ''} />
                </Field>
                <Field id="collect-payer" label="Versé par (facultatif)" hint="Parent, tuteur ou déposant">
                  <input id="collect-payer" value={form.payerName} onChange={set('payerName')} maxLength={120} autoComplete="off" />
                </Field>

                {form.method === 'BANK' && (
                  <>
                    <Field id="collect-bank" label="Banque" error={errors.bankName}>
                      <input id="collect-bank" list="collect-banks" value={form.bankName} onChange={set('bankName')} maxLength={80} className={errors.bankName ? 'invalid' : ''} autoComplete="off" />
                      <datalist id="collect-banks">
                        {BANKS.map((b) => (
                          <option key={b} value={b} />
                        ))}
                      </datalist>
                    </Field>
                    <Field id="collect-slip" label="N° du bordereau de versement" error={errors.externalRef}>
                      <input id="collect-slip" value={form.externalRef} onChange={set('externalRef')} maxLength={64} className={errors.externalRef ? 'invalid' : ''} autoComplete="off" />
                    </Field>
                  </>
                )}

                {form.method === 'MOBILE_MONEY_DIRECT' && (
                  <>
                    <div className="span-2">
                      <div className="op-grid" role="group" aria-label="Opérateur">
                        {Object.entries(OPERATORS).map(([key, op]) => (
                          <button type="button" key={key} className="op" aria-pressed={form.operator === key} onClick={() => setForm((f) => ({ ...f, operator: key }))}>
                            <span className="op-dot" style={{ background: op.color }} />
                            {op.name}
                          </button>
                        ))}
                      </div>
                    </div>
                    <Field id="collect-ref" label="Référence de la transaction" error={errors.externalRef} hint="Figure dans le SMS reçu par le téléphone de l’école">
                      <input id="collect-ref" value={form.externalRef} onChange={set('externalRef')} maxLength={64} className={errors.externalRef ? 'invalid' : ''} autoComplete="off" />
                    </Field>
                    <Field id="collect-phone" label="Numéro de l’expéditeur (facultatif)" error={errors.payerPhone}>
                      <input id="collect-phone" type="tel" value={form.payerPhone} onChange={(e) => onPayerPhone(e.target.value)} className={errors.payerPhone ? 'invalid' : ''} />
                    </Field>
                  </>
                )}

                <div className="span-2">
                  <Field id="collect-note" label="Remarque (facultatif)">
                    <input id="collect-note" value={form.note} onChange={set('note')} maxLength={300} autoComplete="off" />
                  </Field>
                </div>
              </div>
              {onMobileMoney && (
                <button type="button" className="link" onClick={() => onMobileMoney(fee, student)} disabled={busy}>
                  Ou envoyer une demande de paiement Mobile Money au téléphone du parent →
                </button>
              )}
            </>
          )}
        </form>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------- Onglet Caisse */

export function CashbookTab({ session, perms, notify, onLogout, onSlow }) {
  const api = useMemo(() => createFinanceApi(session.token, onSlow), [session.token, onSlow]);
  const today = todayIso();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [method, setMethod] = useState('');
  const [filter, setFilter] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [collectOpen, setCollectOpen] = useState(false);
  const [receiptId, setReceiptId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.journal({ from, to: to < from ? from : to, method });
      setData(res);
      setError('');
    } catch (err) {
      if (err.status === 401) onLogout('Votre session a expiré. Reconnectez-vous.');
      else setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [api, from, to, method, onLogout]);
  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (data?.payments ?? []).filter((p) => !q || `${p.receiptNumber} ${p.studentName} ${p.matricule} ${p.className} ${p.feeLabel} ${p.methodDetails} ${p.cashier}`.toLowerCase().includes(q));
  }, [data, filter]);

  function printJournal() {
    if (!data) return;
    printDocument(<JournalDocument j={data} filterLabel={method ? PAYMENT_METHODS[method]?.label : ''} />, 'a4');
  }

  const single = from === (to < from ? from : to);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Caisse</h1>
          <div className="muted">Journal des encaissements · reçus numérotés · espèces, banque et Mobile Money</div>
        </div>
        <div className="toolbar">
          {perms.collect && (
            <button className="btn btn-primary" onClick={() => setCollectOpen(true)}>
              + Nouvel encaissement
            </button>
          )}
          <button className="btn btn-ghost" onClick={printJournal} disabled={!data}>
            🖨 Imprimer le journal
          </button>
        </div>
      </div>

      <div className="kpis fees-kpis">
        {!data ? (
          [0, 1, 2].map((i) => <div key={i} className="kpi skeleton" style={{ minHeight: 120 }} />)
        ) : (
          <>
            {(data.totals.length ? data.totals : [{ currency: 'USD', total: 0 }]).map((t) => (
              <div className="kpi green" key={t.currency}>
                <span className="kpi-label">Encaissé {single ? (from === today ? 'aujourd’hui' : `le ${formatShortDate(from)}`) : 'sur la période'}</span>
                <span className="kpi-value">{formatMoney(t.total, t.currency)}</span>
                <span className="kpi-foot">Reçus annulés exclus</span>
              </div>
            ))}
            <div className="kpi">
              <span className="kpi-label">Reçus émis</span>
              <span className="kpi-value">{data.count}</span>
              <span className="kpi-foot">{data.cancelledCount ? `${data.cancelledCount} reçu(s) annulé(s)` : 'Aucun reçu annulé'}</span>
            </div>
            <div className="kpi grey">
              <span className="kpi-label">Par mode de paiement</span>
              <div className="cash-chips">
                {data.byMethod.length === 0 && <span className="muted">—</span>}
                {data.byMethod.map((m) => (
                  <span className="chip" key={m.method}>
                    {m.label} · {m.count} · {Object.entries(m.totals).map(([c, v]) => formatMoney(v, c)).join(' / ')}
                  </span>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Journal de caisse</h2>
          {data && <span className="count">{rows.length}</span>}
          <div className="card-tools toolbar">
            <label className="sr-only" htmlFor="cash-from">
              Du
            </label>
            <input id="cash-from" type="date" value={from} max={today} onChange={(e) => e.target.value && setFrom(e.target.value)} />
            <label className="sr-only" htmlFor="cash-to">
              Au
            </label>
            <input id="cash-to" type="date" value={to} min={from} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} />
            <label className="sr-only" htmlFor="cash-method">
              Mode
            </label>
            <select id="cash-method" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="">Tous les modes</option>
              {Object.entries(PAYMENT_METHODS).map(([k, m]) => (
                <option key={k} value={k}>
                  {m.label}
                </option>
              ))}
            </select>
            <input className="search" type="search" placeholder="N° reçu, élève, frais…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtrer le journal" />
          </div>
        </div>
        {error && (
          <div className="card-body">
            <div className="alert alert-error">
              {error}{' '}
              <button className="btn btn-sm btn-ghost" onClick={load}>
                Réessayer
              </button>
            </div>
          </div>
        )}
        {!data && !error && (
          <div className="card-body">
            <div className="skeleton" style={{ height: 160 }} />
          </div>
        )}
        {data && rows.length === 0 && (
          <div className="empty">
            <strong>{data.payments.length === 0 ? 'Aucun encaissement' : 'Aucun résultat'}</strong>
            {data.payments.length === 0 ? (single ? 'Aucun paiement enregistré pour cette date.' : 'Aucun paiement sur cette période.') : 'Modifiez votre recherche.'}
          </div>
        )}
        {data && rows.length > 0 && (
          <div style={{ overflowX: 'auto', opacity: loading ? 0.6 : 1 }}>
            <table className="responsive compact">
              <thead>
                <tr>
                  <th>N° reçu</th>
                  <th>Élève</th>
                  <th>Frais</th>
                  <th>Mode</th>
                  <th>Caissier</th>
                  <th className="num">Montant</th>
                  <th style={{ textAlign: 'right' }}>Reçu</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className={`cash-row ${p.status === 'CANCELLED' ? 'cancelled' : ''}`}>
                    <td className="full c-main" data-label="N° reçu">
                      <div className="student">
                        <b>{p.receiptNumber ?? '—'}</b>
                        <small>
                          {single ? '' : `${formatShortDate(new Intl.DateTimeFormat('en-CA', { timeZone: SCHOOL_TZ }).format(new Date(p.paidAt)))} · `}
                          {formatTime(p.paidAt)}
                        </small>
                      </div>
                    </td>
                    <td data-label="Élève" className="c-sub">
                      {p.studentName} <span className="muted">· {p.className}</span>
                      <span className="show-sm">
                        {' · '}
                        {p.feeLabel} · {PAYMENT_METHODS[p.method]?.short}
                      </span>
                    </td>
                    <td data-label="Frais" className="hide-sm">
                      {p.feeLabel}
                    </td>
                    <td data-label="Mode" className="hide-sm" title={p.methodDetails}>
                      {PAYMENT_METHODS[p.method]?.short ?? p.method}
                      {p.method !== 'CASH' && <div className="muted" style={{ fontSize: 12 }}>{p.methodDetails.split(' · ').slice(1).join(' · ')}</div>}
                    </td>
                    <td data-label="Caissier" className="hide-sm">
                      {p.cashier ?? '—'}
                    </td>
                    <td className="num c-end" data-label="Montant">
                      <b>{formatMoney(p.amount, p.currency)}</b>
                    </td>
                    <td className="full c-act" data-label="Reçu">
                      <div className="actions">
                        {p.status === 'CANCELLED' && (
                          <span className="badge badge-red c-status" title={p.cancelReason ?? ''}>
                            Annulé
                          </span>
                        )}
                        <button className="btn btn-sm btn-ghost" onClick={() => setReceiptId(p.id)}>
                          Voir / imprimer
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data && data.byCashier.length > 0 && (
        <section className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <h2>Clôture de caisse — par caissier</h2>
          </div>
          <div className="card-body">
            {data.byCashier.map((c) => (
              <span className="chip" key={c.cashier}>
                {c.cashier} · {c.count} reçu(s) · {Object.entries(c.totals).map(([cur, v]) => formatMoney(v, cur)).join(' / ')}
              </span>
            ))}
          </div>
        </section>
      )}

      {collectOpen && (
        <CollectModal
          api={api}
          onClose={() => setCollectOpen(false)}
          onDone={load}
          notify={notify}
          onLogout={onLogout}
        />
      )}
      {receiptId && <ReceiptModal api={api} receiptId={receiptId} canCancel={perms.fees} onClose={() => setReceiptId(null)} onChanged={load} notify={notify} onLogout={onLogout} />}
    </>
  );
}
