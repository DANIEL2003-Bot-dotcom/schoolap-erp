import { useMemo, useState } from 'react';
import { formatPct } from './lib.js';

/* =============================================================================
   « En ordre » avec les frais scolaires (autorisation de suivre les cours)
   - Vue sans montant : Directeur, Préfet, D.E., D.D. voient seulement le
     pourcentage des frais échus payé et le statut En ordre / Pas en ordre.
   - Seuil réglé par l'Administrateur (50 % par défaut).
   ============================================================================= */

export const STANDING_CSS = `
.standing{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;white-space:nowrap}
.standing.ok{background:var(--green-50);color:var(--green-600)}
.standing.ko{background:var(--red-50);color:var(--red-600)}
.standing .dot{width:7px;height:7px;border-radius:50%;background:currentColor}
.pct-cell{display:flex;align-items:center;gap:10px;min-width:150px}
.pct-cell .bar{flex:1;min-width:60px}
.pct-cell b{min-width:52px;text-align:right;font-variant-numeric:tabular-nums}
.standing-grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr)}
.standing-grid>div+div{border-left:1px solid var(--grey-200)}
.standing-rule{font-size:13px;color:var(--grey-500)}
.standing-rule b{color:var(--navy-900)}
.standing-banner{display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;padding:12px 14px;border-radius:10px;margin-bottom:14px}
.standing-banner.ok{background:var(--green-50)}
.standing-banner.ko{background:var(--red-50)}
.standing-banner strong{font-size:15px}
.standing-banner.ok strong{color:var(--green-600)}
.standing-banner.ko strong{color:var(--red-600)}
.standing-banner span{font-size:13px;color:var(--grey-700)}
.threshold-box{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;padding:14px 20px;border-bottom:1px solid var(--grey-200);background:var(--grey-50)}
.threshold-box input{width:84px;height:36px;border:1px solid var(--grey-300);border-radius:8px;padding:0 10px;font:inherit;text-align:right}
@media (max-width:900px){
  .standing-grid{grid-template-columns:1fr}
  .standing-grid>div+div{border-left:0;border-top:1px solid var(--grey-200)}
}
`;

/** Pastille « En ordre » / « Pas en ordre », avec le pourcentage payé si connu (jamais de montant). */
export function StandingBadge({ standing, showPercent = true }) {
  if (!standing) return null;
  const pct = standing.paidPercent;
  const pctText = showPercent && pct !== null && pct !== undefined ? ` · ${pct.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %` : '';
  return standing.eligible ? (
    <span className="standing ok" title="Autorisé à suivre les cours">
      <span className="dot" aria-hidden="true" />
      En ordre{pctText}
    </span>
  ) : (
    <span className="standing ko" title="Frais insuffisamment payés : pas autorisé à suivre les cours">
      <span className="dot" aria-hidden="true" />
      Pas en ordre{pctText}
    </span>
  );
}

/** Barre + pourcentage payé (frais échus), sans montant. */
export function PaidPercent({ percent, threshold }) {
  if (percent === null || percent === undefined) return <span className="muted">Aucun frais échu</span>;
  const tone = threshold !== undefined && percent < threshold ? 'red' : 'green';
  return (
    <span className="pct-cell">
      <span className={`bar ${tone}`} aria-hidden="true">
        <span style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
      </span>
      <b>{percent.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %</b>
    </span>
  );
}

/** Bandeau de la fiche élève. */
export function StandingBanner({ standing }) {
  if (!standing) return null;
  return (
    <div className={`standing-banner ${standing.eligible ? 'ok' : 'ko'}`} role="status">
      <strong>{standing.eligible ? '✓ En ordre avec les frais' : '✕ Pas en ordre avec les frais'}</strong>
      <span>
        {standing.paidPercent === null
          ? 'Aucun frais échu pour le moment.'
          : `${standing.paidPercent.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} % des frais échus payés — seuil fixé à ${standing.threshold} %.`}
        {standing.eligible ? ' Autorisé à suivre les cours.' : ' Doit régulariser à la Comptabilité pour suivre les cours.'}
      </span>
    </div>
  );
}

/**
 * Carte du tableau de bord : effectifs en ordre / pas en ordre, par classe,
 * et liste nominative des élèves pas en ordre avec leur pourcentage payé.
 */
export function FeeStandingCard({ data, mobile, limit = 6 }) {
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (data?.notEligible ?? []).filter((r) => !q || `${r.studentName} ${r.className} ${r.matricule}`.toLowerCase().includes(q));
  }, [data, filter]);
  const shown = mobile && !showAll ? rows.slice(0, limit) : rows;

  return (
    <section className="card" aria-labelledby="standing-title" style={{ marginBottom: 24 }}>
      <div className="card-head">
        <h2 id="standing-title">Frais scolaires — élèves pas en ordre</h2>
        <span className="count red">{data?.notEligibleCount ?? 0}</span>
        {data && (
          <span className="standing-rule">
            En ordre : au moins <b>{data.threshold} %</b> des frais échus payés · <b>{formatPct(data.eligibleRate)}</b> des élèves en ordre
          </span>
        )}
        <div className="card-tools">
          <input
            className="search"
            type="search"
            placeholder="Élève, classe…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filtrer les élèves pas en ordre"
          />
        </div>
      </div>
      {!data ? (
        <div className="card-body">
          <div className="skeleton" style={{ height: 160 }} />
        </div>
      ) : (
        <div className="standing-grid">
          <div>
            {rows.length === 0 ? (
              <div className="empty">
                <strong>{data.notEligibleCount === 0 ? 'Tous les élèves sont en ordre' : 'Aucun résultat'}</strong>
                {data.notEligibleCount === 0 ? 'Chaque élève a payé au moins le seuil de ses frais échus.' : 'Modifiez votre recherche.'}
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="responsive compact">
                  <thead>
                    <tr>
                      <th>Élève</th>
                      <th>Classe</th>
                      <th>Frais échus payés</th>
                      <th>Statut</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.studentId}>
                        <td className="full c-main" data-label="Élève">
                          <div className="student">
                            <b>{r.studentName}</b>
                            <small>{r.matricule}</small>
                          </div>
                        </td>
                        <td data-label="Classe" className="c-sub">
                          {r.className}
                        </td>
                        <td data-label="Payé" className="c-end">
                          <PaidPercent percent={r.paidPercent} threshold={data.threshold} />
                        </td>
                        <td data-label="Statut" className="hide-sm">
                          <StandingBadge standing={{ eligible: false, paidPercent: null }} showPercent={false} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {shown.length < rows.length && (
                  <div className="more-row">
                    <button className="btn btn-ghost btn-block" onClick={() => setShowAll(true)}>
                      Afficher les {rows.length - shown.length} autres élèves
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="card-body">
            {data.classes.map((c) => {
              const share = c.enrolled ? c.eligible / c.enrolled : 0;
              return (
                <div className="class-row" key={c.classId}>
                  <div>
                    <div className="class-name">{c.className}</div>
                    <div className="class-meta">
                      {c.eligible}/{c.enrolled} en ordre · payé en moyenne : {c.averagePaidPercent === null ? '—' : `${c.averagePaidPercent.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    {c.notEligible > 0 ? <span className="badge badge-red">{c.notEligible} pas en ordre</span> : <span className="badge badge-sms">Classe en ordre</span>}
                  </div>
                  <div className={`bar ${c.notEligible > 0 ? 'red' : 'green'}`}>
                    <span style={{ width: `${share * 100}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

/** Réglage du seuil « en ordre » (Administrateur) ; simple rappel pour les autres rôles. */
export function ThresholdSetting({ value, canEdit, onSave }) {
  const [draft, setDraft] = useState(String(value));
  const [busy, setBusy] = useState(false);
  const n = Number(draft);
  const valid = draft.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 100;

  async function save(e) {
    e.preventDefault();
    if (!valid || n === value) return;
    setBusy(true);
    try {
      await onSave(n);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="threshold-box" onSubmit={save}>
      <span className="standing-rule">
        Un élève est <b>en ordre</b> (autorisé à suivre les cours) s'il a payé au moins
      </span>
      {canEdit ? (
        <>
          <input
            id="eligibility-threshold"
            type="number"
            min="0"
            max="100"
            step="1"
            inputMode="numeric"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Seuil en pourcentage"
            aria-invalid={!valid}
          />
          <span className="standing-rule">% de ses frais échus.</span>
          <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !valid || n === value}>
            {busy ? <span className="spinner" /> : null} Enregistrer le seuil
          </button>
          {!valid && <span className="standing-rule" style={{ color: 'var(--red-600)' }}>Nombre entier entre 0 et 100.</span>}
        </>
      ) : (
        <span className="standing-rule">
          <b>{value} %</b> de ses frais échus (seuil fixé par l'Administrateur).
        </span>
      )}
    </form>
  );
}
