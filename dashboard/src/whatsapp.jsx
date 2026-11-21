import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, formatDateTime, formatPhone, formatTime } from './lib.js';
import { useAsync } from './ui.jsx';

/* =============================================================================
   Messages aux parents par WhatsApp (API Cloud officielle de Meta)
   - Tous les messages (absences, résultats, reçus, relances) partent sur le
     WhatsApp du tuteur. Pas de SMS de secours : un message non remis apparaît
     dans « Messages non remis » pour que l'école appelle le parent.
   - L'Administrateur suit la liaison Meta, les modèles et envoie un test.
   ============================================================================= */

export const WHATSAPP_CSS = `
.wa-badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;white-space:nowrap}
.wa-badge svg{flex:none}
.wa-badge.sent{background:var(--grey-100);color:var(--grey-700)}
.wa-badge.delivered{background:var(--green-50);color:var(--green-600)}
.wa-badge.read{background:var(--green-50);color:var(--green-600)}
.wa-badge.failed{background:var(--red-50);color:var(--red-600)}
.wa-badge.sms{background:var(--navy-100);color:var(--navy-800)}
.wa-badge.wait{background:var(--grey-100);color:var(--grey-500)}
.wa-fail-list{list-style:none;margin:0;padding:0}
.wa-fail-list li{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:14px 20px;border-bottom:1px solid var(--grey-200)}
.wa-fail-list li:last-child{border-bottom:0}
.wa-fail-main{flex:1;min-width:220px}
.wa-fail-main strong{display:block;color:var(--navy-900)}
.wa-fail-main span{display:block;font-size:13px;color:var(--grey-500)}
.wa-fail-main em{display:block;font-style:normal;font-size:13px;color:var(--red-600);margin-top:2px}
.wa-fail-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.wa-head-note{font-size:13px;color:var(--grey-500)}
.wa-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin-bottom:16px}
.wa-box{padding:16px 20px}
.wa-box dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0;font-size:14px}
.wa-box dt{color:var(--grey-500)}
.wa-box dd{margin:0;color:var(--grey-900);font-weight:600;word-break:break-word}
.wa-mode{display:inline-flex;align-items:center;gap:8px;font-weight:700;font-size:14px;padding:6px 12px;border-radius:999px}
.wa-mode.live{background:var(--green-50);color:var(--green-600)}
.wa-mode.simulation{background:var(--amber-50);color:var(--amber-600)}
.wa-mode.off{background:var(--grey-100);color:var(--grey-700)}
.wa-mode .dot{width:8px;height:8px;border-radius:50%;background:currentColor}
.wa-tpl{border-top:1px solid var(--grey-200);padding:14px 20px}
.wa-tpl-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-bottom:6px}
.wa-tpl-head strong{color:var(--navy-900)}
.wa-tpl-head code{font-size:12px;color:var(--grey-500)}
.wa-tpl pre{margin:0;white-space:pre-wrap;font:inherit;font-size:13px;color:var(--grey-700);background:var(--grey-50);border-radius:8px;padding:10px 12px}
.wa-tpl .why{font-size:13px;color:var(--red-600);margin-top:6px}
.wa-status{font-size:12px;font-weight:700;padding:3px 9px;border-radius:999px;white-space:nowrap}
.wa-status.APPROVED{background:var(--green-50);color:var(--green-600)}
.wa-status.PENDING,.wa-status.IN_APPEAL,.wa-status.UNKNOWN{background:var(--amber-50);color:var(--amber-600)}
.wa-status.REJECTED,.wa-status.DISABLED,.wa-status.PAUSED,.wa-status.MISSING{background:var(--red-50);color:var(--red-600)}
.wa-status.NOT_CONNECTED{background:var(--grey-100);color:var(--grey-700)}
.wa-test{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:16px 20px}
.wa-test input{height:40px;border:1px solid var(--grey-300);border-radius:8px;padding:0 12px;font:inherit;min-width:200px;flex:1;max-width:280px}
.wa-steps{margin:0;padding:4px 20px 16px 38px;font-size:14px;color:var(--grey-700);line-height:1.6}
.wa-kpis{display:flex;flex-wrap:wrap;gap:8px 18px;font-size:14px;color:var(--grey-700)}
.wa-kpis b{color:var(--navy-900)}
`;

const WA_ICON = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2.2A9.7 9.7 0 0 0 3.7 16.9L2.3 21.8l5-1.3A9.7 9.7 0 1 0 12 2.2zm0 17.7a8 8 0 0 1-4.1-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8 8 0 1 1 12 19.9zm4.4-6c-.2-.1-1.4-.7-1.7-.8-.2-.1-.4-.1-.5.1l-.8.9c-.1.2-.3.2-.5.1a6.6 6.6 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.5-.4h-.5a.9.9 0 0 0-.6.3 2.7 2.7 0 0 0-.9 2c0 1.2.9 2.4 1 2.5.1.2 1.7 2.7 4.2 3.8 1.6.7 2.2.7 3 .6.5-.1 1.4-.6 1.6-1.1.2-.6.2-1 .1-1.1l-.5-.5z" />
  </svg>
);

export const MESSAGE_STATUS_LABELS = { sent: 'envoyé', delivered: 'remis', read: 'lu', failed: 'non remis' };

/** Canal et état du dernier message d'absence (liste « Absences du jour »). */
export function MessageBadge({ message, fallbackAt, compact = false }) {
  if (!message) {
    if (fallbackAt) return <span className="wa-badge sent">✓ Prévenu {compact ? '' : '· '}{compact ? '' : formatTime(fallbackAt)}</span>;
    return <span className="wa-badge wait">En attente</span>;
  }
  const at = message.at ? formatTime(message.at) : '';
  if (message.channel === 'SMS') {
    return (
      <span className="wa-badge sms" title={message.at ? `SMS envoyé le ${formatDateTime(message.at)}` : undefined}>
        ✓ SMS {compact ? '' : `envoyé · ${at}`}
      </span>
    );
  }
  const status = String(message.status ?? 'sent').toLowerCase();
  if (status === 'failed') {
    return (
      <span className="wa-badge failed" title={message.error ?? 'Message WhatsApp non remis : appelez le parent.'}>
        {WA_ICON} Non remis{compact ? '' : ' · appelez'}
      </span>
    );
  }
  const tick = status === 'sent' ? '✓' : '✓✓';
  return (
    <span className={`wa-badge ${status}`} title={message.at ? `WhatsApp ${MESSAGE_STATUS_LABELS[status]} — envoyé le ${formatDateTime(message.at)}` : undefined}>
      {WA_ICON} {tick} {compact ? MESSAGE_STATUS_LABELS[status] : `${MESSAGE_STATUS_LABELS[status]} · ${at}`}
    </span>
  );
}

/** Pied de la carte KPI « Messages aux parents ». */
export function messagesKpi(messages, smsSentToday) {
  const wa = messages?.today?.whatsapp;
  if (!messages || messages.whatsappMode === 'off' || !wa) {
    return { label: 'SMS envoyés', value: smsSentToday ?? 0, foot: 'Absences, résultats, relances et reçus du jour', tone: 'grey' };
  }
  const total = wa.total + (messages.today.sms ?? 0);
  const parts = [`${wa.read} lus`, `${wa.delivered} remis`];
  if (wa.failed > 0) parts.push(`${wa.failed} non remis`);
  if (messages.today.sms > 0) parts.push(`${messages.today.sms} par SMS`);
  return { label: 'Messages WhatsApp', value: total, foot: parts.join(' · '), tone: wa.failed > 0 ? 'red' : 'green' };
}

/**
 * « Messages non remis — appelez le parent » : aucun SMS de secours n'est envoyé ;
 * la Direction (ou la Comptable) appelle le tuteur puis clique « Parent appelé ».
 */
export function FailedMessagesCard({ messages, token, notify, onLogout, onSlow, onHandled, mobile }) {
  const [busy, run] = useAsync(notify, onLogout);
  const [hidden, setHidden] = useState(() => new Set());
  const failures = useMemo(() => (messages?.failures ?? []).filter((f) => !hidden.has(f.id)), [messages, hidden]);
  if (!messages || failures.length === 0) return null;

  const handled = async (f) => {
    const res = await run(() => apiFetch(`/api/dashboard/messages/${f.id}/handled`, { token, method: 'POST', onSlow }), {
      success: `C’est noté : le tuteur de ${f.studentName ?? 'l’élève'} a été appelé.`,
    });
    if (res) {
      setHidden((prev) => new Set(prev).add(f.id));
      onHandled?.();
    }
  };

  return (
    <section className="card" aria-labelledby="wa-fail-title" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <h2 id="wa-fail-title">Messages non remis — appelez le parent</h2>
        <span className="count red">{failures.length}</span>
        {!mobile && <span className="wa-head-note">Le parent n’a pas reçu le message WhatsApp. Aucun SMS n’est envoyé à la place.</span>}
      </div>
      <ul className="wa-fail-list">
        {failures.map((f) => (
          <li key={f.id}>
            <div className="wa-fail-main">
              <strong>
                {f.studentName ?? 'Élève'}
                {f.className ? ` · ${f.className}` : ''}
              </strong>
              <span>
                {f.typeLabel} · {formatDateTime(f.createdAt)}
                {f.guardianName ? ` · Tuteur : ${f.guardianName}` : ''}
              </span>
              {f.error && <em>{f.error}</em>}
            </div>
            <div className="wa-fail-actions">
              <a className="btn btn-ghost" href={`tel:${f.guardianPhone}`}>
                Appeler {formatPhone(f.guardianPhone)}
              </a>
              <button className="btn btn-primary" disabled={busy} onClick={() => handled(f)}>
                Parent appelé
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

const MODE_LABELS = {
  live: 'Relié à WhatsApp',
  simulation: 'Simulation (aucun envoi réel)',
  off: 'Pas encore relié — les messages partent en SMS simulé',
};
const TEMPLATE_STATUS_LABELS = {
  APPROVED: 'Approuvé',
  PENDING: 'En cours d’examen par Meta',
  IN_APPEAL: 'En appel',
  REJECTED: 'Refusé',
  DISABLED: 'Désactivé',
  PAUSED: 'En pause',
  MISSING: 'Pas encore soumis',
  UNKNOWN: 'État inconnu',
  NOT_CONNECTED: 'Non relié',
};
const QUALITY_LABELS = { GREEN: 'Bonne', YELLOW: 'Moyenne', RED: 'Faible', UNKNOWN: 'Inconnue' };
const LIMIT_LABELS = {
  TIER_50: '50 parents par jour',
  TIER_250: '250 parents par jour',
  TIER_1K: '1 000 parents par jour',
  TIER_2K: '2 000 parents par jour',
  TIER_10K: '10 000 parents par jour',
  TIER_100K: '100 000 parents par jour',
  TIER_UNLIMITED: 'Illimité',
};

/** Page « WhatsApp » de l'Administrateur. */
export function WhatsAppTab({ session, notify, onLogout, onSlow }) {
  const token = session.token;
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, run] = useAsync(notify, onLogout);

  const load = useCallback(() => {
    apiFetch('/api/admin/whatsapp', { token, onSlow })
      .then((d) => {
        setState(d.whatsapp);
        setError('');
      })
      .catch((err) => (err.status === 401 ? onLogout('Votre session a expiré. Reconnectez-vous.') : setError(err.message)));
  }, [token, onSlow, onLogout]);
  useEffect(load, [load]);

  if (error && !state) return <div className="alert alert-error">{error}</div>;
  if (!state) return <div className="skeleton" style={{ height: 320 }} />;

  const live = state.mode === 'live';
  const missing = state.templates.filter((t) => t.status === 'MISSING' || t.status === 'REJECTED').length;

  const submit = async () => {
    const res = await run(() => apiFetch('/api/admin/whatsapp/templates', { token, method: 'POST', onSlow }));
    if (!res) return;
    const ok = res.submitted.filter((s) => s.submitted).length;
    const ko = res.submitted.filter((s) => !s.submitted);
    if (ko.length) notify({ error: true, text: `${ok} modèle(s) soumis, ${ko.length} en échec.`, sub: ko.map((k) => `${k.label} : ${k.error}`).join(' · ') });
    else notify({ text: ok ? `${ok} modèle(s) soumis à Meta.` : 'Tous les modèles sont déjà soumis.', sub: ok ? 'L’examen par Meta prend en général quelques minutes à quelques heures.' : undefined });
    setState((prev) => ({ ...prev, templates: res.templates }));
  };

  const sendTest = async (e) => {
    e.preventDefault();
    const res = await run(() => apiFetch('/api/admin/whatsapp/test', { token, method: 'POST', body: { phone }, onSlow }));
    if (!res) return;
    if (res.test.status === 'sent') notify({ text: `Message de test envoyé sur WhatsApp au ${formatPhone(res.test.phone)}.`, sub: 'Vérifiez sur ce téléphone qu’il est bien arrivé.' });
    else notify({ error: true, text: 'Le message de test n’est pas parti.', sub: res.test.error });
    load();
  };

  const wa = state.last7Days.whatsapp;
  return (
    <>
      <div className="wa-grid">
        <section className="card wa-box" aria-label="Liaison WhatsApp">
          <div style={{ marginBottom: 12 }}>
            <span className={`wa-mode ${state.mode}`}>
              <span className="dot" />
              {MODE_LABELS[state.mode] ?? state.mode}
            </span>
          </div>
          {live && state.phone ? (
            <dl>
              <dt>Nom affiché</dt>
              <dd>{state.phone.verifiedName ?? '—'}</dd>
              <dt>Numéro</dt>
              <dd>{state.phone.displayPhoneNumber ?? '—'}</dd>
              <dt>Qualité</dt>
              <dd>{QUALITY_LABELS[state.phone.qualityRating] ?? state.phone.qualityRating ?? '—'}</dd>
              <dt>Limite</dt>
              <dd>{LIMIT_LABELS[state.phone.messagingLimit] ?? state.phone.messagingLimit ?? '—'}</dd>
            </dl>
          ) : live && state.phoneError ? (
            <div className="alert alert-error">{state.phoneError}</div>
          ) : (
            <p className="wa-head-note" style={{ margin: 0 }}>
              Le serveur attend les clés du compte WhatsApp Business de l’école (jeton d’accès, identifiant du numéro, identifiant du compte, clé secrète de l’application).
            </p>
          )}
        </section>

        <section className="card wa-box" aria-label="Tuteurs et messages">
          <dl>
            <dt>Tuteurs sur WhatsApp</dt>
            <dd>{state.guardians.whatsapp}</dd>
            <dt>Tuteurs en SMS</dt>
            <dd>{state.guardians.sms}</dd>
          </dl>
          <div className="wa-kpis" style={{ marginTop: 12 }}>
            <span>
              7 derniers jours : <b>{wa.total}</b> WhatsApp
            </span>
            <span>
              <b>{wa.read}</b> lus
            </span>
            <span>
              <b>{wa.delivered}</b> remis
            </span>
            <span>
              <b>{wa.failed}</b> non remis
            </span>
            <span>
              <b>{state.last7Days.sms}</b> SMS
            </span>
          </div>
        </section>
      </div>

      <section className="card" aria-labelledby="wa-tpl-title" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h2 id="wa-tpl-title">Modèles de messages approuvés par Meta</h2>
          <div className="card-tools">
            {live && (
              <button className="btn btn-primary" disabled={busy} onClick={submit}>
                {missing ? `Soumettre ${missing} modèle(s) à Meta` : 'Vérifier les modèles'}
              </button>
            )}
            <button className="btn btn-ghost" disabled={busy} onClick={load}>
              Actualiser
            </button>
          </div>
        </div>
        {state.templatesError && (
          <div className="alert alert-error" style={{ margin: '12px 20px' }}>
            {state.templatesError}
          </div>
        )}
        {state.templates.map((t) => (
          <div className="wa-tpl" key={t.name}>
            <div className="wa-tpl-head">
              <strong>{t.label}</strong>
              <span className={`wa-status ${t.status}`}>{TEMPLATE_STATUS_LABELS[t.status] ?? t.status}</span>
              <code>{t.name}</code>
            </div>
            <pre>{t.body}</pre>
            {t.rejectedReason && t.rejectedReason !== 'NONE' && <div className="why">Motif du refus : {t.rejectedReason}</div>}
          </div>
        ))}
      </section>

      <section className="card" aria-labelledby="wa-test-title" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h2 id="wa-test-title">Envoyer un message de test</h2>
        </div>
        <form className="wa-test" onSubmit={sendTest}>
          <input type="tel" inputMode="tel" placeholder="0970000000" value={phone} onChange={(e) => setPhone(e.target.value)} aria-label="Numéro WhatsApp de test" />
          <button className="btn btn-primary" type="submit" disabled={busy || !live || !phone.trim()}>
            Envoyer le test
          </button>
          {!live && <span className="wa-head-note">Disponible dès que WhatsApp est relié.</span>}
        </form>
      </section>

      <section className="card" aria-labelledby="wa-rules-title">
        <div className="card-head">
          <h2 id="wa-rules-title">Comment ça marche</h2>
        </div>
        <ol className="wa-steps">
          <li>Absences, alertes de résultats, reçus et rappels de paiement partent sur le WhatsApp du tuteur.</li>
          <li>Un tuteur sans WhatsApp : décochez « WhatsApp » sur sa fiche élève, il recevra des SMS.</li>
          <li>Message non remis : aucun SMS n’est envoyé à la place. Il apparaît sur l’accueil dans « Messages non remis » pour que l’école appelle le parent.</li>
          <li>Un parent qui répond « STOP » ne reçoit plus de WhatsApp (sa fiche passe en SMS).</li>
        </ol>
      </section>
    </>
  );
}
