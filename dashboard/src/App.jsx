import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ADMIN_CSS, ADMIN_TABS, AdminView } from './admin.jsx';
import {
  API_URL,
  OPERATORS,
  todayIso,
  addDaysIso,
  daysBetween,
  formatLongDate,
  formatShortDate,
  formatTime,
  formatDateTime,
  formatPct,
  formatMoney,
  formatPhone,
  normalizePhone,
  detectOperator,
  initials,
  apiFetch,
  can,
  ROLE_LABELS,
  tokenExpiry,
  isTokenUsable,
} from './lib.js';
import { PASSWORD_CSS, PasswordInput } from './ui.jsx';

/* =============================================================================
   ERP SCOLAIRE RDC — Tableau de bord du Directeur
   - Accès verrouillé : sans jeton JWT valide (vérifié par l'API), seul l'écran de connexion s'affiche
   - Droits selon la structure EPST (Préfet, Directeur, D.E., D.D., Comptable)
   - KPI : taux de présence du jour, absents, taux de recouvrement, SMS envoyés
   - Tableau des absences avec badge « SMS envoyé »
   - Tableau des insolvables : « Relancer par SMS » + encaissement Mobile Money
   ============================================================================= */

const SESSION_KEY = 'erp.directeur.session';
const REFRESH_MS = 60_000;
const REMINDER_COOLDOWN_MS = 24 * 3_600_000;

function createLiveApi(token, onSlow) {
  return {
    summary: (date) => apiFetch(`/api/dashboard/summary?date=${date}`, { token, onSlow }),
    remind: (feeId) => apiFetch(`/api/fees/${feeId}/remind`, { token, method: 'POST', onSlow }),
    initiatePayment: (body) => apiFetch('/api/payments/mobile-money', { token, method: 'POST', body, onSlow }),
    paymentStatus: (transactionId) => apiFetch(`/api/payments/mobile-money/${encodeURIComponent(transactionId)}`, { token }),
  };
}

/* -------------------------------------------------------------------- Styles */

const CSS = `
:root{
  --navy-900:#0B2545; --navy-800:#13315C; --navy-700:#1D4E89; --navy-100:#E6EDF7;
  --white:#FFFFFF; --grey-50:#F5F7FA; --grey-100:#EEF1F5; --grey-200:#E2E8F0; --grey-300:#CBD5E1;
  --grey-500:#64748B; --grey-700:#334155; --grey-900:#0F172A;
  --red-600:#C62828; --red-50:#FDECEC; --green-600:#1B7F3B; --green-50:#E7F6EC; --amber-600:#B45309; --amber-50:#FEF3C7;
  --radius:14px; --shadow:0 1px 2px rgba(15,23,42,.06),0 4px 16px rgba(15,23,42,.06);
}
*{box-sizing:border-box}
html,body,#root{margin:0;min-height:100%}
body{font-family:"Segoe UI",Roboto,"Helvetica Neue",Arial,system-ui,sans-serif;background:var(--grey-50);color:var(--grey-900);-webkit-font-smoothing:antialiased}
button,input,select{font:inherit}
button{cursor:pointer}
button:disabled{cursor:not-allowed;opacity:.6}
:focus-visible{outline:3px solid #7FB3FF;outline-offset:2px}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* --- Connexion --- */
.login{min-height:100vh;display:grid;grid-template-columns:1.1fr 1fr}
.login-hero{background:linear-gradient(150deg,var(--navy-900),var(--navy-700));color:#fff;padding:56px;display:flex;flex-direction:column;justify-content:space-between}
.login-hero h1{font-size:34px;line-height:1.15;margin:24px 0 12px;font-weight:700}
.login-hero p{color:#C9D6EA;max-width:440px;line-height:1.6}
.hero-list{list-style:none;padding:0;margin:28px 0 0;display:grid;gap:12px}
.hero-list li{display:flex;gap:10px;align-items:center;color:#E6EDF7}
.hero-dot{width:26px;height:26px;border-radius:8px;background:rgba(255,255,255,.12);display:grid;place-items:center;font-size:14px}
.login-panel{display:grid;place-items:center;padding:32px;background:var(--white)}
.login-card{width:100%;max-width:380px}
.login-card h2{margin:0 0 6px;font-size:24px;color:var(--navy-900)}
.login-card .muted{margin:0 0 24px}
.field{display:grid;gap:6px;margin-bottom:16px}
.field label{font-size:13px;font-weight:600;color:var(--grey-700)}
.field input,.field select{height:46px;border:1px solid var(--grey-300);border-radius:10px;padding:0 14px;background:#fff;color:var(--grey-900)}
.field input:focus,.field select:focus{border-color:var(--navy-700);outline:none;box-shadow:0 0 0 3px var(--navy-100)}
.hint{font-size:12px;color:var(--grey-500)}
.btn{height:44px;border-radius:10px;border:1px solid transparent;padding:0 18px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;gap:8px;white-space:nowrap;transition:background .15s,border-color .15s}
.btn-primary{background:var(--navy-900);color:#fff}
.btn-primary:hover:not(:disabled){background:var(--navy-800)}
.btn-ghost{background:#fff;color:var(--navy-900);border-color:var(--grey-300)}
.btn-ghost:hover:not(:disabled){border-color:var(--navy-700);background:var(--navy-100)}
.btn-danger{background:var(--red-600);color:#fff}
.btn-danger:hover:not(:disabled){background:#A61F1F}
.btn-sm{height:34px;padding:0 12px;font-size:13px;border-radius:8px}
.btn-block{width:100%}
.alert{border-radius:10px;padding:12px 14px;font-size:14px;margin-bottom:16px;line-height:1.45}
.alert-error{background:var(--red-50);color:var(--red-600);border:1px solid #F5C2C2}
.alert-info{background:var(--navy-100);color:var(--navy-800);border:1px solid #C8D7EE}
.alert-warn{background:var(--amber-50);color:var(--amber-600);border:1px solid #FCD9A0}

/* --- En-tête --- */
.topbar{background:var(--navy-900);color:#fff;position:sticky;top:0;z-index:20;box-shadow:0 2px 10px rgba(11,37,69,.25)}
.topbar-inner{max-width:1280px;margin:0 auto;padding:12px 24px;display:flex;align-items:center;gap:16px}
.brand{display:flex;align-items:center;gap:12px;min-width:0}
.brand-logo{width:40px;height:40px;border-radius:10px;background:#fff;display:grid;place-items:center;flex:none}
.brand-name{font-weight:700;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.brand-sub{font-size:12px;color:#AFC2DE;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topbar-actions{margin-left:auto;display:flex;align-items:center;gap:10px}
.topbar input[type=date]{height:38px;border-radius:8px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:#fff;padding:0 10px;color-scheme:dark}
.btn-top{height:38px;border-radius:8px;border:1px solid rgba(255,255,255,.25);background:transparent;color:#fff;padding:0 12px;font-weight:600;font-size:13px}
.btn-top:hover:not(:disabled){background:rgba(255,255,255,.1)}
.user-chip{display:flex;align-items:center;gap:8px;padding-left:10px;border-left:1px solid rgba(255,255,255,.2)}
.avatar{width:34px;height:34px;border-radius:50%;background:#fff;color:var(--navy-900);display:grid;place-items:center;font-weight:700;font-size:13px}
.splash{min-height:100vh;display:grid;place-items:center;padding:24px;background:#F4F6FA}
.splash-card{background:#fff;border-radius:16px;padding:32px 28px;max-width:420px;width:100%;text-align:center;box-shadow:0 10px 30px rgba(11,37,69,.12)}
.splash-card .brand-logo{margin:0 auto 14px}
.splash-card p{color:#5B6B82;margin:8px 0 18px}
.role-tag{display:block;font-size:11px;opacity:.75}

/* --- Contenu --- */
.page{max-width:1280px;margin:0 auto;padding:24px}
.page-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:20px}
.page-head h1{margin:0;font-size:24px;color:var(--navy-900)}
.muted{color:var(--grey-500);font-size:14px}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:24px}
.kpi{background:#fff;border-radius:var(--radius);box-shadow:var(--shadow);padding:18px 20px;border-top:4px solid var(--navy-700);display:flex;flex-direction:column;gap:6px;min-height:142px}
.kpi.red{border-top-color:var(--red-600)}
.kpi.green{border-top-color:var(--green-600)}
.kpi.grey{border-top-color:var(--grey-500)}
.kpi-label{font-size:13px;font-weight:600;color:var(--grey-500);text-transform:uppercase;letter-spacing:.4px}
.kpi-value{font-size:34px;font-weight:700;color:var(--navy-900);line-height:1.1;font-variant-numeric:tabular-nums}
.kpi.red .kpi-value{color:var(--red-600)}
.kpi-foot{font-size:13px;color:var(--grey-500);margin-top:auto}
.bar{height:8px;border-radius:99px;background:var(--grey-100);overflow:hidden}
.bar>span{display:block;height:100%;border-radius:99px;background:var(--navy-700);transition:width .6s ease}
.bar.red>span{background:var(--red-600)}
.bar.green>span{background:var(--green-600)}

.grid-2{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:20px;margin-bottom:24px}
.card{background:#fff;border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden}
.card-head{padding:16px 20px;border-bottom:1px solid var(--grey-200);display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.card-head h2{margin:0;font-size:16px;color:var(--navy-900)}
.count{background:var(--grey-100);color:var(--grey-700);font-size:12px;font-weight:700;padding:2px 9px;border-radius:999px}
.count.red{background:var(--red-50);color:var(--red-600)}
.card-tools{margin-left:auto;display:flex;gap:8px;align-items:center}
.search{height:34px;border:1px solid var(--grey-300);border-radius:8px;padding:0 12px;min-width:200px}
.card-body{padding:16px 20px}
.empty{padding:36px 20px;text-align:center;color:var(--grey-500)}
.empty strong{display:block;color:var(--grey-700);margin-bottom:4px}

table{width:100%;border-collapse:collapse;font-size:14px}
thead th{background:var(--grey-50);text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:var(--grey-500);font-weight:700;padding:10px 16px;border-bottom:1px solid var(--grey-200);white-space:nowrap}
tbody td{padding:12px 16px;border-bottom:1px solid var(--grey-100);vertical-align:middle}
tbody tr:hover{background:#FAFBFD}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.student{display:flex;flex-direction:column}
.student b{color:var(--grey-900);font-weight:600}
.student small{color:var(--grey-500);font-size:12px}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;white-space:nowrap}
.badge-sms{background:var(--green-50);color:var(--green-600)}
.badge-wait{background:var(--grey-100);color:var(--grey-500)}
.badge-red{background:var(--red-50);color:var(--red-600)}
.badge-amber{background:var(--amber-50);color:var(--amber-600)}
.remaining{color:var(--red-600);font-weight:700}
.actions{display:flex;gap:6px;justify-content:flex-end;flex-wrap:nowrap}
.reminded{font-size:12px;color:var(--green-600);font-weight:600}

.class-row{display:grid;grid-template-columns:1fr auto;gap:6px 12px;padding:12px 0;border-bottom:1px solid var(--grey-100)}
.class-row:last-child{border-bottom:none}
.class-name{font-weight:600;color:var(--grey-900)}
.class-meta{font-size:12px;color:var(--grey-500)}
.class-row .bar{grid-column:1 / -1}

/* --- Modale de paiement --- */
.backdrop{position:fixed;inset:0;background:rgba(11,37,69,.55);display:grid;place-items:center;padding:16px;z-index:50}
.modal{background:#fff;border-radius:16px;width:100%;max-width:460px;box-shadow:0 20px 60px rgba(0,0,0,.3);overflow:hidden}
.modal-head{background:var(--navy-900);color:#fff;padding:16px 20px;display:flex;align-items:center;justify-content:space-between}
.modal-head h3{margin:0;font-size:17px}
.modal-close{background:transparent;border:none;color:#fff;font-size:22px;line-height:1}
.modal-body{padding:20px}
.modal-foot{padding:0 20px 20px;display:flex;gap:10px;justify-content:flex-end}
.op-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px}
.op{border:2px solid var(--grey-200);border-radius:10px;padding:10px 6px;background:#fff;font-weight:700;font-size:13px;display:flex;flex-direction:column;align-items:center;gap:6px}
.op[aria-pressed=true]{border-color:var(--navy-700);background:var(--navy-100)}
.op-dot{width:12px;height:12px;border-radius:50%}
.steps{list-style:none;padding:0;margin:4px 0 0;display:grid;gap:10px}
.steps li{display:flex;gap:10px;align-items:center;font-size:14px;color:var(--grey-500)}
.steps li.done{color:var(--green-600);font-weight:600}
.steps li.active{color:var(--navy-900);font-weight:600}
.steps li.fail{color:var(--red-600);font-weight:600}
.step-ico{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:var(--grey-100);font-size:12px;flex:none}
.done .step-ico{background:var(--green-50)}
.fail .step-ico{background:var(--red-50)}
.spinner{width:16px;height:16px;border-radius:50%;border:2px solid var(--grey-300);border-top-color:var(--navy-700);animation:spin .8s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}

/* --- Notifications --- */
.toasts{position:fixed;right:16px;bottom:16px;display:grid;gap:10px;z-index:60;max-width:min(420px,calc(100vw - 32px))}
.toast{background:var(--grey-900);color:#fff;border-radius:12px;padding:12px 14px;box-shadow:0 10px 30px rgba(0,0,0,.25);font-size:14px;line-height:1.45;border-left:5px solid var(--green-600)}
.toast.error{border-left-color:var(--red-600)}
.toast small{display:block;color:#CBD5E1;margin-top:4px;font-size:12px}
.skeleton{background:linear-gradient(90deg,var(--grey-100),var(--grey-200),var(--grey-100));background-size:200% 100%;animation:sk 1.2s infinite;border-radius:8px}
@keyframes sk{to{background-position:-200% 0}}
footer{max-width:1280px;margin:0 auto;padding:8px 24px 32px;color:var(--grey-500);font-size:12px;display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between}

/* --- Responsive --- */
@media (max-width:1080px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.grid-2{grid-template-columns:1fr}}
@media (max-width:860px){.login{grid-template-columns:1fr}.login-hero{padding:32px 24px}.login-hero h1{font-size:26px}.hero-list{display:none}}
@media (max-width:720px){
  .topbar-inner{flex-wrap:wrap;padding:10px 16px}
  .topbar-actions{width:100%;margin-left:0}
  .topbar-actions{gap:6px}
  .topbar input[type=date]{flex:1;min-width:0;padding:0 6px}
  .btn-top{padding:0 10px}
  .btn-refresh-label{display:none}
  .user-chip{padding-left:6px;gap:6px}
  .user-chip .user-name,.user-chip .avatar{display:none}
  .page{padding:16px}
  .kpis{gap:12px}
  .kpi{padding:14px;min-height:124px}
  .kpi-value{font-size:28px}
  .search{min-width:0;width:100%}
  .card-tools{width:100%;margin-left:0}
  table.responsive thead{display:none}
  table.responsive tbody tr{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;padding:14px 16px;border-bottom:1px solid var(--grey-200)}
  table.responsive tbody td{padding:0;border:none;text-align:left}
  table.responsive tbody td::before{content:attr(data-label);display:block;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--grey-500);font-weight:700;margin-bottom:2px}
  table.responsive tbody td.full{grid-column:1 / -1}
  table.responsive tbody td.full::before{display:none}
  .actions{justify-content:stretch}
  .actions .btn{flex:1}
}
@media (max-width:420px){.kpis{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

/* ------------------------------------------------------------------ Icônes */

const Logo = ({ size = 26 }) => (
  <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
    <path d="M32 12 6 25l26 13 22-11v15h4V25z" fill="#0B2545" />
    <path d="M17 34v10c0 4.5 6.7 8 15 8s15-3.5 15-8V34l-15 7.5z" fill="#1D4E89" />
  </svg>
);

/* ------------------------------------------------------------------ Connexion */

function LoginScreen({ onLogin }) {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!normalizePhone(phone)) {
      setError('Numéro invalide. Exemple : 0990000001 ou +243 990 000 001.');
      return;
    }
    setBusy(true);
    try {
      const data = await apiFetch('/api/auth/login', { method: 'POST', body: { phone, password }, onSlow: setSlow });
      if (!can(data.user, 'VIEW_SCHOOL')) {
        setError('Ce tableau de bord est réservé à l’administration (Préfet, Direction, D.E., D.D., Comptabilité). Les enseignants utilisent l’application mobile.');
        return;
      }
      onLogin({ token: data.token, user: data.user, school: data.school });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <section className="login-hero">
        <div>
          <div className="brand">
            <div className="brand-logo">
              <Logo />
            </div>
            <div>
              <div className="brand-name">ERP Scolaire RDC</div>
              <div className="brand-sub">Espace Direction</div>
            </div>
          </div>
          <h1>Pilotez votre école en temps réel.</h1>
          <p>Présences du jour remontées par les enseignants, alertes SMS aux parents et recouvrement des frais scolaires via Mobile Money.</p>
          <ul className="hero-list">
            <li>
              <span className="hero-dot">✓</span> Taux de présence et absents du jour
            </li>
            <li>
              <span className="hero-dot">✉</span> SMS automatiques aux tuteurs
            </li>
            <li>
              <span className="hero-dot">$</span> M-Pesa, Orange Money, Airtel Money
            </li>
          </ul>
        </div>
        <p style={{ fontSize: 12, color: '#8FA6C8', margin: 0 }}>Conforme à l’organisation EPST — Année scolaire septembre → juillet.</p>
      </section>

      <section className="login-panel">
        <form className="login-card" onSubmit={submit} noValidate>
          <h2>Connexion</h2>
          <p className="muted">Identifiez-vous avec votre numéro de téléphone.</p>
          {error && (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          )}
          {slow && busy && (
            <div className="alert alert-warn" role="status">
              Le serveur gratuit se réveille… cela peut prendre jusqu’à une minute.
            </div>
          )}
          <div className="field">
            <label htmlFor="phone">Téléphone</label>
            <input id="phone" type="tel" inputMode="tel" autoComplete="username" placeholder="+243 990 000 001" value={phone} onChange={(e) => setPhone(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="password">Mot de passe</label>
            <PasswordInput id="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={4} />
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={busy || !phone || !password}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            {busy ? 'Connexion…' : 'Se connecter'}
          </button>
          <p className="hint" style={{ marginTop: 14 }}>
            API : {API_URL || 'même origine (proxy de développement)'}
          </p>
        </form>
      </section>
    </div>
  );
}

/* --------------------------------------------------------------- Paiement MM */

function PaymentModal({ fee, api, onClose, onDone, notify }) {
  const [phone, setPhone] = useState(fee.guardianPhone);
  const [operator, setOperator] = useState(detectOperator(fee.guardianPhone) || 'MPESA');
  const [amount, setAmount] = useState(String(fee.remaining));
  const [phase, setPhase] = useState('form'); // form | sending | pending | success | failed
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    const onKey = (e) => e.key === 'Escape' && phase !== 'sending' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      cancelled.current = true;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, phase]);

  const e164 = normalizePhone(phone);
  const detected = e164 ? detectOperator(e164) : null;
  const numericAmount = Number(String(amount).replace(',', '.'));
  const amountOk = Number.isFinite(numericAmount) && numericAmount > 0 && numericAmount <= fee.remaining;

  function onPhoneChange(value) {
    setPhone(value);
    const p = normalizePhone(value);
    const op = p && detectOperator(p);
    if (op) setOperator(op);
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!e164) return setError('Numéro invalide (ex : 0810000000).');
    if (detected !== operator) return setError(`Ce numéro n’appartient pas au réseau ${OPERATORS[operator].name}.`);
    if (!amountOk) return setError(`Montant entre 0,01 et ${formatMoney(fee.remaining, fee.currency)}.`);
    setPhase('sending');
    try {
      const init = await api.initiatePayment({
        studentId: fee.studentId,
        schoolFeeId: fee.feeId,
        operator,
        phone: e164,
        amount: Math.round(numericAmount * 100) / 100,
      });
      setInfo(init);
      setPhase('pending');
      const started = Date.now();
      while (!cancelled.current && Date.now() - started < 90_000) {
        await new Promise((r) => setTimeout(r, 1500));
        if (cancelled.current) return;
        const st = await api.paymentStatus(init.transactionId);
        if (st.status === 'SUCCESS') {
          setInfo({ ...init, ...st });
          setPhase('success');
          notify({ text: `Paiement confirmé : ${formatMoney(st.amount, st.currency)} pour ${fee.studentName}.`, sub: `Reçu SMS envoyé au tuteur · ${init.transactionId}` });
          onDone();
          return;
        }
        if (st.status === 'FAILED') {
          setInfo({ ...init, ...st });
          setPhase('failed');
          return;
        }
      }
      if (!cancelled.current) {
        setPhase('failed');
        setInfo((i) => ({ ...i, failureReason: 'Aucune confirmation de l’opérateur après 90 secondes.' }));
      }
    } catch (err) {
      if (cancelled.current) return;
      setPhase('form');
      setError(err.message);
    }
  }

  const step = (state, label, key) => (
    <li className={state} key={key}>
      <span className="step-ico">{state === 'done' ? '✓' : state === 'fail' ? '✕' : state === 'active' ? <span className="spinner" /> : '•'}</span>
      {label}
    </li>
  );

  return (
    <div className="backdrop" role="dialog" aria-modal="true" aria-labelledby="pay-title" onMouseDown={(e) => e.target === e.currentTarget && phase !== 'sending' && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h3 id="pay-title">Encaissement Mobile Money</h3>
          <button className="modal-close" onClick={onClose} aria-label="Fermer" disabled={phase === 'sending'}>
            ×
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body">
            <p style={{ margin: '0 0 4px', fontWeight: 700 }}>{fee.studentName}</p>
            <p className="muted" style={{ margin: '0 0 16px' }}>
              {fee.className} · {fee.label} · reste <span className="remaining">{formatMoney(fee.remaining, fee.currency)}</span>
            </p>

            {error && (
              <div className="alert alert-error" role="alert">
                {error}
              </div>
            )}

            {phase === 'form' || phase === 'sending' ? (
              <>
                <div className="op-grid" role="group" aria-label="Opérateur">
                  {Object.entries(OPERATORS).map(([key, op]) => (
                    <button type="button" key={key} className="op" aria-pressed={operator === key} onClick={() => setOperator(key)}>
                      <span className="op-dot" style={{ background: op.color }} />
                      {op.name}
                    </button>
                  ))}
                </div>
                <div className="field">
                  <label htmlFor="pay-phone">Téléphone du payeur</label>
                  <input id="pay-phone" type="tel" value={phone} onChange={(e) => onPhoneChange(e.target.value)} />
                  <span className="hint">{e164 ? (detected ? `Réseau détecté : ${OPERATORS[detected].name}` : 'Réseau non reconnu') : 'Format : 08X/09X XXX XXXX'}</span>
                </div>
                <div className="field">
                  <label htmlFor="pay-amount">Montant ({fee.currency})</label>
                  <input id="pay-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
                </div>
              </>
            ) : (
              <ul className="steps" aria-live="polite">
                {step('done', `Demande envoyée à ${OPERATORS[info.operator].name} (${info.transactionId})`, 's1')}
                {step(
                  phase === 'pending' ? 'active' : phase === 'success' ? 'done' : 'fail',
                  phase === 'pending'
                    ? 'En attente de la saisie du code PIN par le payeur…'
                    : phase === 'success'
                      ? 'Paiement confirmé par webhook opérateur'
                      : `Échec : ${info.failureReason || 'refusé par l’opérateur'}`,
                  's2',
                )}
                {step(
                  phase === 'success' ? 'done' : '',
                  phase === 'success'
                    ? `Solde mis à jour — reste ${formatMoney(info.fee?.remaining ?? 0, fee.currency)} (${info.fee?.status === 'SOLDE' ? 'Soldé' : 'partiel'})`
                    : 'Mise à jour automatique du solde de l’élève',
                  's3',
                )}
              </ul>
            )}
          </div>
          <div className="modal-foot">
            {phase === 'form' || phase === 'sending' ? (
              <>
                <button type="button" className="btn btn-ghost" onClick={onClose} disabled={phase === 'sending'}>
                  Annuler
                </button>
                <button type="submit" className="btn btn-primary" disabled={phase === 'sending'}>
                  {phase === 'sending' ? <span className="spinner" /> : null} Envoyer la demande
                </button>
              </>
            ) : phase === 'failed' ? (
              <>
                <button type="button" className="btn btn-ghost" onClick={onClose}>
                  Fermer
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setPhase('form');
                    setInfo(null);
                  }}
                >
                  Réessayer
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-primary" onClick={onClose}>
                {phase === 'pending' ? 'Fermer (le suivi continue côté serveur)' : 'Terminer'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ Tableau de bord */

function Kpi({ tone = '', label, value, foot, bar, barTone }) {
  return (
    <article className={`kpi ${tone}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {bar !== undefined && (
        <div className={`bar ${barTone || ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((bar || 0) * 100)}>
          <span style={{ width: `${Math.max(0, Math.min(1, bar || 0)) * 100}%` }} />
        </div>
      )}
      <span className="kpi-foot">{foot}</span>
    </article>
  );
}

function Dashboard({ session, onLogout }) {
  const [slow, setSlow] = useState(false);
  const api = useMemo(() => createLiveApi(session.token, setSlow), [session]);
  const canCollect = can(session.user, 'MANAGE_FEES');
  const [date, setDate] = useState(todayIso());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [absFilter, setAbsFilter] = useState('');
  const [insFilter, setInsFilter] = useState('');
  const [reminders, setReminders] = useState({});
  const [payFee, setPayFee] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [tab, setTab] = useState('dashboard');
  const today = todayIso();

  const notify = useCallback((t) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((list) => [...list, { id, ...t }]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), 6000);
  }, []);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const res = await api.summary(date);
        setData(res);
        setError('');
      } catch (err) {
        if (err.status === 401) {
          onLogout('Votre session a expiré. Reconnectez-vous.');
          return;
        }
        setError(err.message);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [api, date, onLogout],
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (date !== today || tab !== 'dashboard') return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load(true);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, date, today, tab]);

  async function remind(fee) {
    setReminders((r) => ({ ...r, [fee.feeId]: { state: 'sending' } }));
    try {
      const res = await api.remind(fee.feeId);
      setReminders((r) => ({ ...r, [fee.feeId]: { state: 'sent', at: res.remindedAt } }));
      notify({ text: `SMS de relance envoyé au tuteur de ${fee.studentName}.`, sub: res.sms.message });
      load(true);
    } catch (err) {
      if (err.status === 401) return onLogout('Votre session a expiré. Reconnectez-vous.');
      const next = err.details?.nextAllowedAt;
      setReminders((r) => ({ ...r, [fee.feeId]: { state: err.status === 429 ? 'cooldown' : 'error', next } }));
      notify({ error: true, text: err.message, sub: next ? `Prochaine relance possible : ${formatDateTime(next)}` : undefined });
    }
  }

  const absents = useMemo(() => {
    const q = absFilter.trim().toLowerCase();
    return (data?.absents ?? []).filter((a) => !q || `${a.studentName} ${a.className} ${a.matricule}`.toLowerCase().includes(q));
  }, [data, absFilter]);

  const insolvents = useMemo(() => {
    const q = insFilter.trim().toLowerCase();
    return (data?.insolvents ?? []).filter((f) => !q || `${f.studentName} ${f.className} ${f.matricule} ${f.label}`.toLowerCase().includes(q));
  }, [data, insFilter]);

  const att = data?.attendance;
  const usd = data?.finance?.find((f) => f.currency === 'USD');
  const cdf = data?.finance?.find((f) => f.currency === 'CDF');
  const outstandingTotal = (data?.insolvents ?? []).reduce((s, f) => s + (f.currency === 'USD' ? f.remaining : 0), 0);

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <div className="brand-logo">
              <Logo />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="brand-name">{data?.school?.name ?? session.school?.name ?? 'Établissement'}</div>
              <div className="brand-sub">
                Code EPST {data?.school?.epstCode ?? session.school?.epstCode ?? '—'} · {data?.school?.city ?? session.school?.city ?? ''} · {data?.schoolYear ?? ''}
              </div>
            </div>
          </div>
          <div className="topbar-actions">
            {tab === 'dashboard' && (
              <>
                <label className="sr-only" htmlFor="day">
                  Date
                </label>
                <input id="day" type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} />
                <button className="btn-top" onClick={() => load()} disabled={loading} aria-label="Actualiser">
                  ↻<span className="btn-refresh-label"> Actualiser</span>
                </button>
              </>
            )}
            <div className="user-chip">
              <span className="avatar" aria-hidden="true">
                {initials(session.user.fullName)}
              </span>
              <span className="user-name" style={{ fontSize: 13 }}>
                {session.user.fullName}
                <span className="role-tag">
                  {session.user.roleLabel ?? ROLE_LABELS[session.user.role]}
                  {session.user.office ? ` · ${session.user.office.name}` : ''}
                </span>
              </span>
              <button className="btn-top" onClick={() => onLogout()}>
                Quitter
              </button>
            </div>
          </div>
        </div>
      </header>

      <nav className="tabs" aria-label="Sections">
        <div className="tabs-inner" role="tablist">
          {[{ id: 'dashboard', label: 'Tableau de bord' }, ...ADMIN_TABS].map((t) => (
            <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      {tab !== 'dashboard' ? (
        <main className="page">
          <AdminView tab={tab} session={session} notify={notify} onLogout={onLogout} onSlow={setSlow} />
        </main>
      ) : (
        <main className="page">
          <div className="page-head">
            <div>
              <h1>Tableau de bord du Directeur</h1>
              <div className="muted">
                {formatLongDate(date)}
                {data ? ` · mis à jour à ${formatTime(data.generatedAt)}` : ''}
              </div>
            </div>
            {att?.classesPending?.length > 0 && <span className="badge badge-amber">Appel non fait : {att.classesPending.join(', ')}</span>}
          </div>

          {slow && loading && <div className="alert alert-warn">Le serveur gratuit se réveille… les données arrivent dans quelques secondes.</div>}
          {error && (
            <div className="alert alert-error" role="alert">
              {error}{' '}
              <button className="btn btn-sm btn-ghost" onClick={() => load()} style={{ marginLeft: 8 }}>
                Réessayer
              </button>
            </div>
          )}

          <section className="kpis" aria-label="Indicateurs clés">
            {!data ? (
              [0, 1, 2, 3].map((i) => <div key={i} className="kpi skeleton" style={{ minHeight: 142 }} />)
            ) : (
              <>
                <Kpi
                  tone={att.rate !== null && att.rate < 0.85 ? 'red' : 'green'}
                  label="Taux de présence"
                  value={formatPct(att.rate)}
                  bar={att.rate ?? 0}
                  barTone={att.rate !== null && att.rate < 0.85 ? 'red' : 'green'}
                  foot={att.marked > 0 ? `${att.present} présents sur ${att.marked} élèves pointés (${att.enrolled} inscrits)` : 'Aucun appel enregistré pour cette date'}
                />
                <Kpi tone="red" label="Absents" value={att.absent} foot={`${att.classes.filter((c) => c.rollCallDone).length}/${att.classes.length} classes ont fait l’appel`} />
                <Kpi
                  label="Taux de recouvrement"
                  value={formatPct(usd?.recoveryRate ?? null)}
                  bar={usd?.recoveryRate ?? 0}
                  foot={
                    usd ? `${formatMoney(usd.paid)} encaissés sur ${formatMoney(usd.due)} exigibles${cdf ? ` · ${formatPct(cdf.recoveryRate)} en FC` : ''}` : 'Aucun frais exigible'
                  }
                />
                <Kpi tone="grey" label="SMS envoyés" value={data.smsSentToday} foot="Alertes d’absence, relances et reçus du jour" />
              </>
            )}
          </section>

          <div className="grid-2">
            <section className="card" aria-labelledby="abs-title">
              <div className="card-head">
                <h2 id="abs-title">Absences du jour</h2>
                <span className="count red">{data?.absents?.length ?? 0}</span>
                <div className="card-tools">
                  <input
                    className="search"
                    type="search"
                    placeholder="Rechercher un élève…"
                    value={absFilter}
                    onChange={(e) => setAbsFilter(e.target.value)}
                    aria-label="Filtrer les absences"
                  />
                </div>
              </div>
              {data && absents.length === 0 ? (
                <div className="empty">
                  <strong>{data.absents.length === 0 ? 'Aucune absence signalée' : 'Aucun résultat'}</strong>
                  {data.absents.length === 0 ? 'Les absences apparaissent dès la synchronisation des appels.' : 'Modifiez votre recherche.'}
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="responsive">
                    <thead>
                      <tr>
                        <th>Élève</th>
                        <th>Classe</th>
                        <th>Tuteur</th>
                        <th>Notification</th>
                      </tr>
                    </thead>
                    <tbody>
                      {absents.map((a) => (
                        <tr key={a.attendanceId}>
                          <td className="full" data-label="Élève">
                            <div className="student">
                              <b>{a.studentName}</b>
                              <small>{a.matricule}</small>
                            </div>
                          </td>
                          <td data-label="Classe">{a.className}</td>
                          <td data-label="Tuteur" style={{ whiteSpace: 'nowrap' }}>
                            {formatPhone(a.guardianPhone)}
                          </td>
                          <td data-label="Notification">
                            {a.smsSent ? (
                              <span className="badge badge-sms" title={`Envoyé le ${formatDateTime(a.smsSentAt)}`}>
                                ✓ SMS envoyé · {formatTime(a.smsSentAt)}
                              </span>
                            ) : (
                              <span className="badge badge-wait">En attente</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="card" aria-labelledby="cls-title">
              <div className="card-head">
                <h2 id="cls-title">Appel par classe</h2>
              </div>
              <div className="card-body">
                {!data ? (
                  <div className="skeleton" style={{ height: 160 }} />
                ) : (
                  att.classes.map((c) => {
                    const rate = c.rollCallDone ? c.present / (c.present + c.absent) : 0;
                    return (
                      <div className="class-row" key={c.id}>
                        <div>
                          <div className="class-name">{c.name}</div>
                          <div className="class-meta">
                            {c.teacher ?? 'Sans titulaire'} · {c.enrolled} élèves
                          </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          {c.rollCallDone ? (
                            <>
                              <b>{formatPct(rate)}</b>
                              <div className="class-meta">{c.absent} absent(s)</div>
                            </>
                          ) : (
                            <span className="badge badge-amber">Appel en attente</span>
                          )}
                        </div>
                        <div className={`bar ${rate < 0.85 ? 'red' : 'green'}`}>
                          <span style={{ width: `${rate * 100}%` }} />
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </div>

          <section className="card" aria-labelledby="ins-title">
            <div className="card-head">
              <h2 id="ins-title">Comptabilité — élèves insolvables</h2>
              <span className="count red">{data?.insolvents?.length ?? 0}</span>
              {data && (
                <span className="muted">
                  Reste à recouvrer : <b className="remaining">{formatMoney(outstandingTotal)}</b>
                </span>
              )}
              <div className="card-tools">
                <input
                  className="search"
                  type="search"
                  placeholder="Élève, classe, frais…"
                  value={insFilter}
                  onChange={(e) => setInsFilter(e.target.value)}
                  aria-label="Filtrer les insolvables"
                />
              </div>
            </div>
            {data && insolvents.length === 0 ? (
              <div className="empty">
                <strong>{data.insolvents.length === 0 ? 'Aucun élève insolvable' : 'Aucun résultat'}</strong>
                {data.insolvents.length === 0 ? 'Tous les frais échus sont soldés.' : 'Modifiez votre recherche.'}
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="responsive">
                  <thead>
                    <tr>
                      <th>Élève</th>
                      <th>Classe</th>
                      <th>Frais</th>
                      <th className="num">Payé / Dû</th>
                      <th className="num">Reste</th>
                      <th>Échéance</th>
                      <th>Dernière relance</th>
                      <th style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {insolvents.map((f) => {
                      const r = reminders[f.feeId];
                      const lastAt = r?.at ?? f.lastReminderAt;
                      const inCooldown = lastAt && Date.now() - Date.parse(lastAt) < REMINDER_COOLDOWN_MS;
                      const late = daysBetween(f.dueDate, today);
                      return (
                        <tr key={f.feeId}>
                          <td className="full" data-label="Élève">
                            <div className="student">
                              <b>{f.studentName}</b>
                              <small>
                                {f.matricule} · {formatPhone(f.guardianPhone)}
                              </small>
                            </div>
                          </td>
                          <td data-label="Classe">{f.className}</td>
                          <td data-label="Frais">{f.label}</td>
                          <td className="num" data-label="Payé / Dû">
                            {formatMoney(f.amountPaid, f.currency)} / {formatMoney(f.amountDue, f.currency)}
                          </td>
                          <td className="num remaining" data-label="Reste">
                            {formatMoney(f.remaining, f.currency)}
                          </td>
                          <td data-label="Échéance">
                            {formatShortDate(f.dueDate)} <span className="badge badge-red">J+{late}</span>
                          </td>
                          <td data-label="Dernière relance">{lastAt ? <span className="reminded">✓ {formatDateTime(lastAt)}</span> : <span className="muted">Jamais</span>}</td>
                          <td className="full" data-label="Actions">
                            {canCollect ? (
                            <div className="actions">
                              <button
                                className="btn btn-sm btn-danger"
                                onClick={() => remind(f)}
                                disabled={r?.state === 'sending' || inCooldown}
                                title={inCooldown ? 'Une seule relance par 24 h et par frais' : 'Envoyer un SMS de rappel au tuteur'}
                              >
                                {r?.state === 'sending' ? <span className="spinner" /> : '✉'} {inCooldown ? 'Relancé' : 'Relancer par SMS'}
                              </button>
                              <button className="btn btn-sm btn-ghost" onClick={() => setPayFee(f)}>
                                Encaisser
                              </button>
                            </div>
                            ) : (
                              <span className="muted">Réservé à la Comptabilité</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </main>
      )}

      <footer>
        <span>ERP Scolaire RDC · Données en direct — {API_URL || 'API sur la même origine (proxy)'}</span>
        <span>{tab === 'dashboard' ? 'Actualisation automatique toutes les 60 s' : 'Gestion administrative'}</span>
      </footer>

      {payFee && <PaymentModal fee={payFee} api={api} onClose={() => setPayFee(null)} onDone={() => load(true)} notify={notify} />}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>
            {t.text}
            {t.sub && <small>{t.sub}</small>}
          </div>
        ))}
      </div>
    </>
  );
}

/* ---------------------------------------------------------------------- App */

function readSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    const stored = raw ? JSON.parse(raw) : null;
    // Toute session sans jeton exploitable (absent, illisible ou expiré) est détruite d'office.
    if (!stored?.token || !isTokenUsable(stored.token)) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return stored;
  } catch {
    return null;
  }
}

function writeSession(s) {
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* stockage indisponible (navigation privée stricte) : session en mémoire uniquement */
  }
}

/** Écran d'attente pendant la vérification du jeton auprès de l'API (aucune donnée affichée avant). */
function SessionCheck({ error, slow, onRetry, onLogout }) {
  return (
    <div className="splash">
      <div className="splash-card" role="status" aria-live="polite">
        <div className="brand-logo">
          <Logo />
        </div>
        <h2 style={{ margin: 0 }}>{error ? 'Vérification impossible' : 'Vérification de la session…'}</h2>
        <p>{error || (slow ? 'Le serveur gratuit se réveille… cela peut prendre jusqu’à une minute.' : 'Connexion sécurisée à l’API en cours.')}</p>
        {error ? (
          <div className="actions" style={{ justifyContent: 'center' }}>
            <button className="btn btn-primary" onClick={onRetry}>
              Réessayer
            </button>
            <button className="btn btn-ghost" onClick={() => onLogout()}>
              Se reconnecter
            </button>
          </div>
        ) : (
          <span className="spinner" style={{ borderColor: '#C9D6EA', borderTopColor: '#1D4E89' }} aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(readSession);
  // Une session restaurée depuis le navigateur n'est affichée qu'après validation par GET /api/auth/me.
  const [verified, setVerified] = useState(false);
  const [checkError, setCheckError] = useState('');
  const [checkSlow, setCheckSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState('');

  const logout = useCallback((message) => {
    writeSession(null);
    setSession(null);
    setVerified(false);
    setCheckError('');
    setNotice(typeof message === 'string' ? message : '');
  }, []);

  const login = useCallback((s) => {
    writeSession(s);
    setNotice('');
    setCheckError('');
    setVerified(true);
    setSession(s);
  }, []);

  // Validation serveur du jeton restauré : signature, expiration et compte toujours actif.
  useEffect(() => {
    if (!session || verified) return undefined;
    let cancelled = false;
    setCheckError('');
    setCheckSlow(false);
    apiFetch('/api/auth/me', { token: session.token, onSlow: setCheckSlow })
      .then((me) => {
        if (cancelled) return;
        if (!can(me.user, 'VIEW_SCHOOL')) {
          logout('Ce compte n’a pas accès au tableau de bord.');
          return;
        }
        const fresh = { token: session.token, user: me.user, school: me.school };
        writeSession(fresh);
        setSession(fresh);
        setVerified(true);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.status === 401 || err.status === 403) logout('Votre session n’est plus valide. Reconnectez-vous.');
        else setCheckError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [session, verified, attempt, logout]);

  // Déconnexion automatique à l'expiration du jeton, y compris au retour sur un onglet resté en veille.
  useEffect(() => {
    if (!session) return undefined;
    const exp = tokenExpiry(session.token);
    const expire = () => logout('Votre session a expiré. Reconnectez-vous.');
    if (!exp || exp <= Date.now()) {
      expire();
      return undefined;
    }
    const timer = setTimeout(expire, Math.min(exp - Date.now(), 2_147_000_000));
    const onVisible = () => document.visibilityState === 'visible' && !isTokenUsable(session.token) && expire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [session, logout]);

  // Aucune adresse profonde : tout chemin ou ancre résiduel est ramené à la racine de l'application.
  useEffect(() => {
    if (session) return undefined;
    const clean = () => {
      if (window.location.hash || window.location.search) window.history.replaceState(null, '', window.location.pathname);
    };
    clean();
    window.addEventListener('hashchange', clean);
    window.addEventListener('popstate', clean);
    return () => {
      window.removeEventListener('hashchange', clean);
      window.removeEventListener('popstate', clean);
    };
  }, [session]);

  let content;
  if (session && verified) content = <Dashboard session={session} onLogout={logout} />;
  else if (session) content = <SessionCheck error={checkError} slow={checkSlow} onRetry={() => setAttempt((n) => n + 1)} onLogout={logout} />;
  else
    content = (
      <>
        {notice && (
          <div className="alert alert-info" style={{ position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 70, margin: 0 }}>
            {notice}
          </div>
        )}
        <LoginScreen onLogin={login} />
      </>
    );

  return (
    <>
      <style>{CSS + PASSWORD_CSS + ADMIN_CSS}</style>
      {content}
    </>
  );
}
