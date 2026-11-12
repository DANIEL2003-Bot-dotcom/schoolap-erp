import { useMemo, useState } from 'react';
import { formatDateTime } from './lib.js';

/* =============================================================================
   Suivi des résultats — « Élèves en difficulté » (tableau de bord de la direction)
   Alertes ouvertes automatiquement à la saisie des cotes :
   moyenne sous 50 %, baisse d'au moins 10 points, deux échecs de suite.
   ============================================================================= */

export const PASS_MARK = 50;

export const SIGNAL_TEXT = {
  ECHECS_CONSECUTIFS: 'Deux échecs de suite',
  FAIBLE: 'Moyenne sous 50 %',
  CHUTE: 'Baisse des résultats',
};

export const PERF_CSS = `
.perf-card{margin-bottom:24px;border-top:4px solid var(--amber-600)}
.perf-intro{padding:12px 20px;background:var(--amber-50);color:#7C3E06;font-size:13px;line-height:1.5;border-bottom:1px solid #FCD9A0}
.perf-chips{display:flex;flex-wrap:wrap;gap:6px}
.chip-signal{display:inline-flex;align-items:center;font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;background:var(--red-50);color:var(--red-600);white-space:nowrap}
.chip-signal.CHUTE{background:var(--amber-50);color:var(--amber-600)}
.perf-summary{font-size:13px;color:var(--grey-700);line-height:1.45;margin-top:3px}
.pct{font-weight:700;font-variant-numeric:tabular-nums}
.pct.low{color:var(--red-600)}
.pct.ok{color:var(--green-600)}
.perf-followed{font-size:12px;color:var(--green-600);font-weight:600}
.perf-note{font-size:12px;color:var(--grey-500);display:block;margin-top:2px}
.perf-filter{display:flex;gap:6px;flex-wrap:wrap}
.perf-filter button{height:34px;border-radius:999px;border:1px solid var(--grey-300);background:#fff;padding:0 12px;font-size:13px;font-weight:600;color:var(--grey-700)}
.perf-filter button[aria-pressed=true]{background:var(--navy-900);border-color:var(--navy-900);color:#fff}
.ack-form{display:grid;gap:10px}
.ack-form textarea{min-height:84px;border:1px solid var(--grey-300);border-radius:10px;padding:10px 12px;font:inherit;resize:vertical}
.avg-table td,.avg-table th{padding:8px 10px}
.avg-legend{font-size:12px;color:var(--grey-500);margin-top:8px}
@media (max-width:720px){
  .perf-intro{padding:10px 14px}
  .perf-filter{width:100%}
  .perf-filter button{flex:1;height:42px}
}
`;

/** Pourcentage coloré : rouge sous 50 %, vert au-dessus. */
export function Pct({ value }) {
  if (value == null) return <span className="muted">—</span>;
  return <span className={`pct ${value < PASS_MARK ? 'low' : 'ok'}`}>{Math.round(value)} %</span>;
}

export function SignalChips({ signals }) {
  return (
    <span className="perf-chips">
      {signals.map((s) => (
        <span key={s} className={`chip-signal ${s}`}>
          {SIGNAL_TEXT[s] ?? s}
        </span>
      ))}
    </span>
  );
}

function AckModal({ alert, onClose, onConfirm }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const ok = await onConfirm(note.trim());
    setBusy(false);
    if (ok) onClose();
  }
  return (
    <div className="backdrop" role="dialog" aria-modal="true" aria-labelledby="ack-title" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <form onSubmit={submit}>
          <div className="modal-head">
            <h3 id="ack-title">Élève pris en charge</h3>
            <button type="button" className="modal-close" onClick={onClose} aria-label="Fermer">
              ×
            </button>
          </div>
          <div className="modal-body ack-form">
            <div>
              <b>{alert.studentName}</b> · {alert.className}
              <div className="perf-summary">{alert.summary}</div>
            </div>
            <label className="field" style={{ margin: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--grey-700)' }}>Suite donnée (facultatif)</span>
              <textarea value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Ex. : parent convoqué lundi, cours de remédiation le mercredi…" />
            </label>
            <div className="hint">L’alerte reste visible jusqu’à ce que les résultats remontent ; elle se ferme alors toute seule.</div>
          </div>
          <div className="modal-foot">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Annuler
            </button>
            <button className="btn btn-primary" disabled={busy}>
              {busy ? <span className="spinner" /> : '✓'} Marquer comme suivi
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Carte « Élèves en difficulté » du tableau de bord.
 * @param data   performanceAlerts du résumé ({ openCount, studentsCount, pendingStudents, alerts })
 * @param api    { acknowledgeAlert(alertId, note) }
 */
export function PerformanceCard({ data, api, notify, onLogout, onChanged, mobile, limit = 8 }) {
  const [filter, setFilter] = useState('ACTIVE');
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [acking, setAcking] = useState(null);
  const alerts = data?.alerts ?? [];

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return alerts.filter(
      (a) =>
        (filter === 'ALL' || a.status === filter) &&
        (!q || `${a.studentName} ${a.className} ${a.subjectName ?? 'moyenne générale'} ${a.matricule}`.toLowerCase().includes(q)),
    );
  }, [alerts, filter, query]);
  const shown = mobile && !showAll ? list.slice(0, limit) : list;
  const pending = alerts.filter((a) => a.status === 'ACTIVE').length;

  async function acknowledge(note) {
    try {
      await api.acknowledgeAlert(acking.id, note);
      notify({ text: `${acking.studentName} : élève marqué comme suivi.` });
      onChanged();
      return true;
    } catch (err) {
      if (err.status === 401) {
        onLogout('Votre session a expiré. Reconnectez-vous.');
        return false;
      }
      notify({ error: true, text: err.message });
      return false;
    }
  }

  return (
    <section className="card perf-card" aria-labelledby="perf-title">
      <div className="card-head">
        <h2 id="perf-title">Élèves en difficulté — résultats en baisse</h2>
        <span className={`count ${data?.studentsCount ? 'red' : ''}`}>{data?.studentsCount ?? 0}</span>
        {data && data.studentsCount > 0 && (
          <span className="muted">
            {data.pendingStudents} élève(s) à prendre en charge · {data.openCount} alerte(s)
          </span>
        )}
        <div className="card-tools">
          <div className="perf-filter" role="group" aria-label="Filtrer les alertes">
            <button type="button" aria-pressed={filter === 'ACTIVE'} onClick={() => setFilter('ACTIVE')}>
              À traiter ({pending})
            </button>
            <button type="button" aria-pressed={filter === 'ACKNOWLEDGED'} onClick={() => setFilter('ACKNOWLEDGED')}>
              Suivis ({alerts.length - pending})
            </button>
            <button type="button" aria-pressed={filter === 'ALL'} onClick={() => setFilter('ALL')}>
              Tous
            </button>
          </div>
          {alerts.length > 6 && (
            <input className="search" type="search" placeholder="Élève, classe, matière…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filtrer les élèves en difficulté" />
          )}
        </div>
      </div>
      <div className="perf-intro">
        Alerte automatique dès la saisie des cotes : <b>moyenne sous 50 %</b>, <b>baisse d’au moins 10 points</b> ou <b>deux échecs de suite</b> dans une matière.
        Le titulaire est prévenu dans son application et le tuteur reçoit un seul SMS par baisse.
      </div>
      {!data ? (
        <div className="card-body">
          <div className="skeleton" style={{ height: 120 }} />
        </div>
      ) : list.length === 0 ? (
        <div className="empty">
          <strong>{alerts.length === 0 ? 'Aucun élève en difficulté' : filter === 'ACTIVE' ? 'Tous les élèves signalés sont suivis' : 'Aucun résultat'}</strong>
          {alerts.length === 0 ? 'Les alertes apparaissent dès que les enseignants synchronisent leurs cotes.' : 'Changez le filtre ou la recherche.'}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="responsive compact">
            <thead>
              <tr>
                <th>Élève</th>
                <th>Classe</th>
                <th>Matière</th>
                <th>Signal</th>
                <th className="num">Moyenne</th>
                <th>Tuteur</th>
                <th style={{ textAlign: 'right' }}>Suivi</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((a) => (
                <tr key={a.id}>
                  <td className="full c-main" data-label="Élève">
                    <div className="student">
                      <b>{a.studentName}</b>
                      <small>
                        {a.matricule} · {a.term}
                      </small>
                      <span className="perf-summary">{a.summary}</span>
                    </div>
                  </td>
                  <td data-label="Classe" className="c-sub">
                    {a.className}
                    <span className="show-sm"> · {a.subjectName ?? 'Moyenne générale'}</span>
                  </td>
                  <td data-label="Matière" className="hide-sm">
                    {a.subjectName ?? <i>Moyenne générale</i>}
                  </td>
                  <td data-label="Signal" className="hide-sm">
                    <SignalChips signals={a.signals} />
                  </td>
                  <td className="num hide-sm" data-label="Moyenne">
                    <Pct value={a.averagePct ?? a.lastPct} />
                  </td>
                  <td data-label="Tuteur" className="hide-sm">
                    {a.smsStatus === 'SENT' ? (
                      <span className="badge badge-sms" title={`Envoyé le ${formatDateTime(a.smsSentAt)}`}>
                        ✓ SMS envoyé
                      </span>
                    ) : a.smsStatus === 'SKIPPED_RECENT' ? (
                      <span className="badge badge-wait" title="Un SMS sur les résultats a déjà été envoyé dans les dernières 24 h">
                        Déjà prévenu
                      </span>
                    ) : (
                      <span className="badge badge-wait">—</span>
                    )}
                  </td>
                  <td className="c-end" data-label="Suivi" style={{ textAlign: 'right' }}>
                    {a.status === 'ACKNOWLEDGED' ? (
                      <span className="perf-followed" title={a.acknowledgedAt ? `Le ${formatDateTime(a.acknowledgedAt)}` : undefined}>
                        ✓ Suivi{a.acknowledgedBy ? ` par ${a.acknowledgedBy}` : ''}
                        {a.note && <span className="perf-note">{a.note}</span>}
                      </span>
                    ) : (
                      <button className="btn btn-sm btn-ghost" onClick={() => setAcking(a)}>
                        Prendre en charge
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length < list.length && (
            <div className="more-row">
              <button className="btn btn-ghost btn-block" onClick={() => setShowAll(true)}>
                Afficher les {list.length - shown.length} autres alertes
              </button>
            </div>
          )}
        </div>
      )}
      {acking && <AckModal alert={acking} onClose={() => setAcking(null)} onConfirm={acknowledge} />}
    </section>
  );
}

/** Bloc « Résultats scolaires » de la fiche élève : moyennes par matière et par trimestre. */
export function StudentPerformance({ performance }) {
  if (!performance) return null;
  const { subjects, averages, alerts } = performance;
  const terms = ['T1', 'T2', 'T3'].filter((t) => averages.terms[t]);
  if (!subjects.length) return <div className="muted">Aucune cote enregistrée pour cet élève.</div>;
  return (
    <div>
      {alerts.length > 0 && (
        <div className="alert alert-warn" role="status" style={{ marginBottom: 10 }}>
          <b>Résultats en baisse :</b>
          {alerts.map((a) => (
            <div key={a.id} style={{ marginTop: 4 }}>
              • {a.summary}
              {a.status === 'ACKNOWLEDGED' && <span className="perf-followed"> — suivi{a.note ? ` (${a.note})` : ''}</span>}
            </div>
          ))}
        </div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table className="avg-table">
          <thead>
            <tr>
              <th>Matière</th>
              {terms.map((t) => (
                <th key={t} className="num">
                  {t}
                </th>
              ))}
              <th className="num">Année</th>
            </tr>
          </thead>
          <tbody>
            {subjects.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                {terms.map((t) => (
                  <td key={t} className="num">
                    <Pct value={averages.terms[t].subjects[s.id]} />
                  </td>
                ))}
                <td className="num">
                  <Pct value={averages.year.subjects[s.id]} />
                </td>
              </tr>
            ))}
            <tr>
              <td>
                <b>Moyenne générale</b>
              </td>
              {terms.map((t) => (
                <td key={t} className="num">
                  <Pct value={averages.terms[t].general} />
                </td>
              ))}
              <td className="num">
                <Pct value={averages.year.general} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="avg-legend">Moyenne = total des points obtenus ÷ total des points possibles. Seuil de réussite : 50 %.</div>
    </div>
  );
}
