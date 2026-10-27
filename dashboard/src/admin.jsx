import { useCallback, useEffect, useMemo, useState } from 'react';
import { PASSWORD_HINT, ROLE_LABELS, apiFetch, can, formatMoney, formatPct, formatPhone, formatShortDate, isStrongPassword, normalizePhone, todayIso } from './lib.js';
import { PasswordInput } from './ui.jsx';
import { useIsMobile } from './mobile.jsx';

/* =============================================================================
   Gestion administrative — structure EPST
   (Préfet, Directeur, D.E., D.D., Comptable ; boutons masqués selon les droits)
   - Élèves : inscription, modification, transfert, désinscription, fiche
     (frais + paiements), import CSV avec vérification préalable
   - Classes & personnel : classes et titulaires, bureaux (Direction, Études,
     Discipline, Comptabilité, Salle des profs), comptes du personnel, matières
   - Frais : synthèse par frais, création groupée par classe, remise / report
   ============================================================================= */

const FEE_TYPES = {
  INSCRIPTION: 'Inscription',
  MINERVAL: 'Minerval',
  FRAIS_SCOLAIRES: 'Frais scolaires',
  FRAIS_CONNEXES: 'Frais connexes',
  FRAIS_EXAMEN: 'Frais d’examen',
  UNIFORME: 'Uniforme',
  AUTRE: 'Autre',
};
const FEE_STATUS = {
  SOLDE: { label: 'Soldé', cls: 'badge-sms' },
  EN_COURS: { label: 'En cours', cls: 'badge-amber' },
  INSOLVABLE: { label: 'Insolvable', cls: 'badge-red' },
};
const TX_STATUS = {
  SUCCESS: { label: 'Confirmé', cls: 'badge-sms' },
  PENDING: { label: 'En attente', cls: 'badge-amber' },
  FAILED: { label: 'Échoué', cls: 'badge-red' },
};
const OPERATOR_NAMES = { MPESA: 'M-Pesa', ORANGE_MONEY: 'Orange Money', AIRTEL_MONEY: 'Airtel Money' };
const CSV_TEMPLATE =
  'nom;postnom;prenom;sexe;telephone_tuteur;nom_tuteur;matricule\n' + 'Mumbere;Kakule;Fiston;M;0971112233;Papa Mumbere;\n' + 'Kahambu;Vagheni;Aline;F;0841112233;Maman Kahambu;\n';

export const ADMIN_CSS = `
.offices{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;padding:14px 16px 16px}
.office{border:1px solid #E3E8F0;border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:6px;background:#FAFBFD}
.office-head{display:flex;justify-content:space-between;align-items:center;gap:8px}
.office small{color:#5B6B82;line-height:1.35}
.office-people{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px}
.tabs{background:#fff;border-bottom:1px solid var(--grey-200);position:sticky;top:64px;z-index:15}
.tabs-inner{max-width:1280px;margin:0 auto;padding:0 24px;display:flex;gap:4px;overflow-x:auto;scrollbar-width:none}
.tabs-inner::-webkit-scrollbar{display:none}
.tab{border:none;background:transparent;padding:14px 16px;font-weight:600;font-size:14px;color:var(--grey-500);border-bottom:3px solid transparent;white-space:nowrap}
.tab:hover{color:var(--navy-900)}
.tab[aria-selected=true]{color:var(--navy-900);border-bottom-color:var(--navy-700)}
.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.toolbar select,.toolbar input{height:38px;border:1px solid var(--grey-300);border-radius:8px;padding:0 10px;background:#fff;min-width:0}
.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 14px}
.form-grid .span-2{grid-column:1 / -1}
.field textarea{border:1px solid var(--grey-300);border-radius:10px;padding:10px 12px;font:13px/1.45 ui-monospace,Consolas,monospace;min-height:140px;resize:vertical}
.field .err{color:var(--red-600);font-size:12px}
.field input.invalid,.field select.invalid{border-color:var(--red-600)}
.modal.wide{max-width:760px}
.modal-body.scroll{max-height:min(70vh,640px);overflow:auto}
.pager{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 20px;font-size:13px;color:var(--grey-500)}
.checks{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:6px;padding:10px;border:1px solid var(--grey-200);border-radius:10px;max-height:200px;overflow:auto;margin-bottom:16px}
.checks label{display:flex;gap:8px;align-items:center;font-size:14px}
.stat-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:16px}
.stat{background:var(--grey-50);border-radius:10px;padding:10px 12px}
.stat b{display:block;font-size:20px;color:var(--navy-900)}
.stat span{font-size:12px;color:var(--grey-500)}
.err-list{margin:0;padding:0;list-style:none;max-height:220px;overflow:auto;font-size:13px}
.err-list li{padding:6px 0;border-bottom:1px solid var(--grey-100)}
.err-list b{color:var(--red-600);margin-right:6px}
.kpis.fees-kpis{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.show-sm{display:none}
.tel-link{color:inherit;text-decoration:none;white-space:nowrap}
.chip{display:inline-flex;align-items:center;gap:6px;background:var(--grey-100);border-radius:999px;padding:4px 10px;font-size:13px;margin:0 6px 6px 0}
.inline-form{display:flex;gap:8px;flex-wrap:wrap;padding:12px 20px;border-top:1px solid var(--grey-200)}
.inline-form input{height:36px;border:1px solid var(--grey-300);border-radius:8px;padding:0 10px;min-width:0}
.fee-edit{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.fee-edit input{height:32px;border:1px solid var(--grey-300);border-radius:8px;padding:0 8px;width:110px}
.link{background:none;border:none;color:var(--navy-700);font-weight:600;padding:0;text-decoration:underline}
.inactive td{color:var(--grey-500)}
.switch-line{display:flex;align-items:center;gap:10px;margin-bottom:16px;font-size:14px}
@media (max-width:720px){
  .tabs{position:static}
  .tabs-inner{padding:0 8px}
  .form-grid{grid-template-columns:1fr}
  .toolbar{width:100%}
  .toolbar>*{flex:1 1 140px}
  .stat-row{grid-template-columns:1fr 1fr 1fr}
  .show-sm{display:inline}
  table.compact tbody td.c-act{grid-column:1 / -1;grid-row:3;margin-top:8px}
  table.compact tbody td.c-act:empty{display:none}
  .tel-link{color:var(--navy-700);font-weight:600}
}
`;

/* ------------------------------------------------------------------ API */

function createAdminApi(token, onSlow) {
  const call = (path, method = 'GET', body) => apiFetch(`/api/admin${path}`, { token, method, body, onSlow });
  return {
    overview: () => call('/overview'),
    createClass: (b) => call('/classes', 'POST', b),
    updateClass: (id, b) => call(`/classes/${id}`, 'PATCH', b),
    deleteClass: (id) => call(`/classes/${id}`, 'DELETE'),
    createUser: (b) => call('/users', 'POST', b),
    updateUser: (id, b) => call(`/users/${id}`, 'PATCH', b),
    createSubject: (b) => call('/subjects', 'POST', b),
    updateSubject: (id, b) => call(`/subjects/${id}`, 'PATCH', b),
    listStudents: (params) => call(`/students?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString()}`),
    getStudent: (id) => call(`/students/${id}`),
    createStudent: (b) => call('/students', 'POST', b),
    updateStudent: (id, b) => call(`/students/${id}`, 'PATCH', b),
    importStudents: (b) => call('/students/import', 'POST', b),
    feeSummary: () => call('/fees/summary'),
    bulkFees: (b) => call('/fees/bulk', 'POST', b),
    updateFee: (id, b) => call(`/fees/${id}`, 'PATCH', b),
  };
}

/** Transforme les détails de validation de l'API en { champ: message }. */
function fieldErrors(err) {
  if (!Array.isArray(err?.details)) return {};
  return Object.fromEntries(err.details.filter((d) => d.field).map((d) => [d.field, d.message]));
}

/* ------------------------------------------------------------ Composants */

function Modal({ title, onClose, wide = false, children, footer }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-close" onClick={onClose} aria-label="Fermer">
            ×
          </button>
        </div>
        <div className="modal-body scroll">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

function Field({ id, label, error, hint, children }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? <span className="err">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

function useAsync(notify, onLogout) {
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (fn, { success, onError } = {}) => {
      setBusy(true);
      try {
        const res = await fn();
        if (success) notify({ text: typeof success === 'function' ? success(res) : success });
        return res;
      } catch (err) {
        if (err.status === 401) {
          onLogout('Votre session a expiré. Reconnectez-vous.');
          return null;
        }
        if (onError) onError(err);
        else notify({ error: true, text: err.message });
        return null;
      } finally {
        setBusy(false);
      }
    },
    [notify, onLogout],
  );
  return [busy, run];
}

/* ================================================================ Élèves */

const EMPTY_STUDENT = {
  lastName: '',
  middleName: '',
  firstName: '',
  gender: 'F',
  guardianName: '',
  guardianPhone: '',
  matricule: '',
  classId: '',
  applyClassFees: true,
  isActive: true,
};

function StudentForm({ api, classes, student, defaultClassId, onClose, onSaved, notify, onLogout }) {
  const editing = Boolean(student);
  const [form, setForm] = useState(() =>
    editing
      ? { ...EMPTY_STUDENT, ...student, guardianName: student.guardianName ?? '', guardianPhone: formatPhone(student.guardianPhone) }
      : { ...EMPTY_STUDENT, classId: defaultClassId || classes[0]?.id || '' },
  );
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState('');
  const [busy, run] = useAsync(notify, onLogout);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function submit(e) {
    e.preventDefault();
    const local = {};
    if (!normalizePhone(form.guardianPhone)) local.guardianPhone = 'Numéro RDC invalide (ex : 0970000000).';
    for (const k of ['lastName', 'middleName', 'firstName']) if (!form[k].trim()) local[k] = 'Obligatoire.';
    setErrors(local);
    if (Object.keys(local).length) return;
    const base = {
      lastName: form.lastName,
      middleName: form.middleName,
      firstName: form.firstName,
      gender: form.gender,
      guardianName: form.guardianName || null,
      guardianPhone: form.guardianPhone,
      classId: form.classId,
    };
    const res = await run(
      () =>
        editing
          ? api.updateStudent(student.id, { ...base, matricule: form.matricule, isActive: form.isActive })
          : api.createStudent({ ...base, matricule: form.matricule || null, applyClassFees: form.applyClassFees }),
      {
        success: (r) =>
          editing
            ? `Fiche de ${r.student.fullName} mise à jour.`
            : `${r.student.fullName} inscrit(e) — matricule ${r.student.matricule}${r.feesCreated ? `, ${r.feesCreated} frais attribués` : ''}.`,
        onError: (err) => {
          setErrors(fieldErrors(err));
          setMessage(err.message);
        },
      },
    );
    if (res) onSaved(res.student);
  }

  return (
    <Modal
      title={editing ? `Modifier — ${student.fullName}` : 'Inscrire un élève'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} type="button">
            Annuler
          </button>
          <button className="btn btn-primary" type="submit" form="student-form" disabled={busy}>
            {busy ? <span className="spinner" /> : editing ? 'Enregistrer' : 'Inscrire'}
          </button>
        </>
      }
    >
      <form id="student-form" onSubmit={submit} noValidate>
        {message && <div className="alert alert-error">{message}</div>}
        <div className="form-grid">
          <Field id="s-last" label="Nom" error={errors.lastName}>
            <input id="s-last" value={form.lastName} onChange={set('lastName')} className={errors.lastName ? 'invalid' : ''} autoFocus />
          </Field>
          <Field id="s-middle" label="Postnom" error={errors.middleName}>
            <input id="s-middle" value={form.middleName} onChange={set('middleName')} className={errors.middleName ? 'invalid' : ''} />
          </Field>
          <Field id="s-first" label="Prénom" error={errors.firstName}>
            <input id="s-first" value={form.firstName} onChange={set('firstName')} className={errors.firstName ? 'invalid' : ''} />
          </Field>
          <Field id="s-gender" label="Sexe" error={errors.gender}>
            <select id="s-gender" value={form.gender} onChange={set('gender')}>
              <option value="F">Féminin</option>
              <option value="M">Masculin</option>
            </select>
          </Field>
          <Field id="s-gname" label="Nom du tuteur" error={errors.guardianName}>
            <input id="s-gname" value={form.guardianName} onChange={set('guardianName')} placeholder="Facultatif" />
          </Field>
          <Field id="s-gphone" label="Téléphone du tuteur (SMS)" error={errors.guardianPhone} hint="Reçoit les alertes d’absence et les relances.">
            <input
              id="s-gphone"
              value={form.guardianPhone}
              onChange={set('guardianPhone')}
              inputMode="tel"
              placeholder="0970000000"
              className={errors.guardianPhone ? 'invalid' : ''}
            />
          </Field>
          <Field id="s-class" label={editing ? 'Classe (transfert)' : 'Classe'} error={errors.classId}>
            <select id="s-class" value={form.classId} onChange={set('classId')}>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field id="s-mat" label="Matricule" error={errors.matricule} hint={editing ? undefined : 'Laisser vide : attribution automatique.'}>
            <input id="s-mat" value={form.matricule} onChange={set('matricule')} placeholder={editing ? '' : 'Automatique'} />
          </Field>
        </div>
        {editing ? (
          <label className="switch-line">
            <input type="checkbox" checked={form.isActive} onChange={set('isActive')} /> Élève inscrit (décocher pour désinscrire — l’historique est conservé)
          </label>
        ) : (
          <label className="switch-line">
            <input type="checkbox" checked={form.applyClassFees} onChange={set('applyClassFees')} /> Attribuer les frais de la classe pour l’année en cours
          </label>
        )}
      </form>
    </Modal>
  );
}

function FeeRow({ fee, api, onChanged, notify, onLogout, canEdit }) {
  const [editing, setEditing] = useState(false);
  const [amountDue, setAmountDue] = useState(String(fee.amountDue));
  const [dueDate, setDueDate] = useState(fee.dueDate);
  const [busy, run] = useAsync(notify, onLogout);
  const st = FEE_STATUS[fee.status];

  async function save() {
    const amount = Number(amountDue.replace(',', '.'));
    if (!Number.isFinite(amount) || amount < 0) return notify({ error: true, text: 'Montant invalide.' });
    const res = await run(() => api.updateFee(fee.id, { amountDue: amount, dueDate }), { success: `« ${fee.label} » mis à jour.` });
    if (res) {
      setEditing(false);
      onChanged();
    }
  }

  return (
    <tr>
      <td data-label="Frais" className="full">
        <div className="student">
          <b>{fee.label}</b>
          <small>{fee.schoolYear}</small>
        </div>
      </td>
      <td data-label="Échéance">
        {editing ? <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} aria-label="Échéance" style={{ height: 32 }} /> : formatShortDate(fee.dueDate)}
      </td>
      <td data-label="Dû" className="num">
        {editing ? (
          <span className="fee-edit">
            <input value={amountDue} onChange={(e) => setAmountDue(e.target.value)} inputMode="decimal" aria-label="Montant dû" />
          </span>
        ) : (
          formatMoney(fee.amountDue, fee.currency)
        )}
      </td>
      <td data-label="Payé" className="num">
        {formatMoney(fee.amountPaid, fee.currency)}
      </td>
      <td data-label="Statut">
        <span className={`badge ${st.cls}`}>{st.label}</span>
      </td>
      <td data-label="" className="full">
        {canEdit && (
          <div className="actions">
            {editing ? (
              <>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)} disabled={busy}>
                  Annuler
                </button>
                <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
                  OK
                </button>
              </>
            ) : (
              <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)} title="Remise ou report d’échéance">
                Remise / report
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

function StudentDetail({ api, studentId, onClose, onEdit, canEditFees, notify, onLogout }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api
      .getStudent(studentId)
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((err) => (err.status === 401 ? onLogout('Votre session a expiré. Reconnectez-vous.') : setError(err.message)));
  }, [api, studentId, onLogout]);
  useEffect(load, [load]);

  const s = data?.student;
  const totals = useMemo(() => {
    const t = {};
    for (const f of data?.fees ?? []) {
      t[f.currency] ??= { due: 0, paid: 0 };
      t[f.currency].due += f.amountDue;
      t[f.currency].paid += f.amountPaid;
    }
    return t;
  }, [data]);

  return (
    <Modal
      wide
      title={s ? s.fullName : 'Fiche élève'}
      onClose={onClose}
      footer={
        s && (
          <>
            <button className="btn btn-ghost" onClick={onClose}>
              Fermer
            </button>
            {onEdit && (
              <button className="btn btn-primary" onClick={() => onEdit(s)}>
                Modifier la fiche
              </button>
            )}
          </>
        )
      }
    >
      {error && <div className="alert alert-error">{error}</div>}
      {!data && !error && <div className="skeleton" style={{ height: 160 }} />}
      {s && (
        <>
          <div style={{ marginBottom: 12 }}>
            <span className="chip">Matricule : {s.matricule}</span>
            <span className="chip">{s.className}</span>
            <span className="chip">{s.gender === 'F' ? 'Fille' : 'Garçon'}</span>
            <span className="chip">
              Tuteur : {s.guardianName ? `${s.guardianName} · ` : ''}
              {formatPhone(s.guardianPhone)}
            </span>
            {!s.isActive && <span className="badge badge-red">Désinscrit</span>}
          </div>
          <div className="stat-row">
            <div className="stat">
              <b>{formatPct(data.attendance.rate)}</b>
              <span>
                Assiduité ({data.attendance.present} P / {data.attendance.absent} A)
              </span>
            </div>
            {Object.entries(totals).map(([cur, t]) => (
              <div className="stat" key={cur}>
                <b>{formatMoney(t.due - t.paid, cur)}</b>
                <span>Reste à payer sur {formatMoney(t.due, cur)}</span>
              </div>
            ))}
          </div>
          <h4 style={{ margin: '8px 0', color: 'var(--navy-900)' }}>Frais scolaires</h4>
          {data.fees.length === 0 ? (
            <div className="empty">Aucun frais attribué.</div>
          ) : (
            <table className="responsive">
              <thead>
                <tr>
                  <th>Frais</th>
                  <th>Échéance</th>
                  <th className="num">Dû</th>
                  <th className="num">Payé</th>
                  <th>Statut</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.fees.map((f) => (
                  <FeeRow key={`${f.id}-${f.amountDue}-${f.dueDate}`} fee={f} api={api} onChanged={load} notify={notify} onLogout={onLogout} canEdit={canEditFees} />
                ))}
              </tbody>
            </table>
          )}
          <h4 style={{ margin: '20px 0 8px', color: 'var(--navy-900)' }}>Paiements Mobile Money</h4>
          {data.transactions.length === 0 ? (
            <div className="empty">Aucun paiement.</div>
          ) : (
            <table className="responsive">
              <thead>
                <tr>
                  <th>Transaction</th>
                  <th>Opérateur</th>
                  <th className="num">Montant</th>
                  <th>Statut</th>
                </tr>
              </thead>
              <tbody>
                {data.transactions.map((t) => (
                  <tr key={t.transactionId}>
                    <td data-label="Transaction" className="full">
                      <div className="student">
                        <b>{t.transactionId}</b>
                        <small>{new Date(t.createdAt).toLocaleString('fr-FR')}</small>
                      </div>
                    </td>
                    <td data-label="Opérateur">{OPERATOR_NAMES[t.operator] ?? t.operator}</td>
                    <td data-label="Montant" className="num">
                      {formatMoney(t.amount, t.currency)}
                    </td>
                    <td data-label="Statut">
                      <span className={`badge ${TX_STATUS[t.status].cls}`} title={t.failureReason ?? ''}>
                        {TX_STATUS[t.status].label}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Modal>
  );
}

function ImportModal({ api, classes, defaultClassId, onClose, onDone, notify, onLogout }) {
  const [classId, setClassId] = useState(defaultClassId || classes[0]?.id || '');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [applyClassFees, setApplyClassFees] = useState(true);
  const [check, setCheck] = useState(null); // { valid, preview } | { errors }
  const [busy, run] = useAsync(notify, onLogout);

  function readFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      setCsv(String(reader.result));
      setCheck(null);
    };
    reader.readAsText(file, 'utf-8');
  }

  async function verify() {
    setCheck(null);
    const res = await run(() => api.importStudents({ classId, csv, dryRun: true, applyClassFees }), {
      onError: (err) => setCheck({ message: err.message, errors: err.details?.errors ?? fieldErrorsList(err) }),
    });
    if (res) setCheck({ valid: res.valid, preview: res.preview });
  }

  async function confirm() {
    const res = await run(() => api.importStudents({ classId, csv, dryRun: false, applyClassFees }), {
      success: (r) => `${r.imported} élève(s) importé(s)${r.feesCreated ? `, ${r.feesCreated} frais attribués` : ''}.`,
      onError: (err) => setCheck({ message: err.message, errors: err.details?.errors ?? fieldErrorsList(err) }),
    });
    if (res) onDone();
  }

  const templateHref = `data:text/csv;charset=utf-8,${encodeURIComponent('\uFEFF' + CSV_TEMPLATE)}`;

  return (
    <Modal
      wide
      title="Importer des élèves (CSV)"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Annuler
          </button>
          {check?.valid ? (
            <button className="btn btn-primary" onClick={confirm} disabled={busy}>
              {busy ? <span className="spinner" /> : `Importer ${check.valid} élève(s)`}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={verify} disabled={busy || !csv.trim() || !classId}>
              {busy ? <span className="spinner" /> : 'Vérifier le fichier'}
            </button>
          )}
        </>
      }
    >
      <div className="alert alert-info">
        Une ligne par élève, séparateur « ; » ou « , ». Colonnes : <b>nom ; postnom ; prenom ; sexe (M/F) ; telephone_tuteur</b> ; nom_tuteur et matricule facultatifs. L’import est
        « tout ou rien » : s’il reste une erreur, aucun élève n’est créé.{' '}
        <a href={templateHref} download="modele-import-eleves.csv">
          Télécharger le modèle
        </a>
      </div>
      <div className="form-grid">
        <Field id="i-class" label="Classe de destination">
          <select
            id="i-class"
            value={classId}
            onChange={(e) => {
              setClassId(e.target.value);
              setCheck(null);
            }}
          >
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="i-file" label="Fichier CSV (Excel : Enregistrer sous → CSV UTF-8)" hint={fileName || undefined}>
          <input id="i-file" type="file" accept=".csv,text/csv,text/plain" onChange={readFile} style={{ paddingTop: 10 }} />
        </Field>
        <div className="span-2">
          <Field id="i-csv" label="… ou collez le contenu ici">
            <textarea
              id="i-csv"
              value={csv}
              onChange={(e) => {
                setCsv(e.target.value);
                setCheck(null);
              }}
              placeholder={CSV_TEMPLATE}
              spellCheck={false}
            />
          </Field>
        </div>
      </div>
      <label className="switch-line">
        <input type="checkbox" checked={applyClassFees} onChange={(e) => setApplyClassFees(e.target.checked)} /> Attribuer les frais de la classe aux élèves importés
      </label>
      {check?.errors && (
        <div className="alert alert-error">
          <strong>{check.message}</strong>
          <ul className="err-list">
            {check.errors.map((e, i) => (
              <li key={i}>
                {e.line ? <b>Ligne {e.line}</b> : null}
                {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {check?.valid && (
        <>
          <div className="alert alert-info" style={{ background: 'var(--green-50)', color: 'var(--green-600)', borderColor: '#BFE5CB' }}>
            Fichier valide : {check.valid} élève(s) prêt(s) à être importé(s). Aperçu :
          </div>
          <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Ligne</th>
                <th>Élève</th>
                <th>Sexe</th>
                <th>Tuteur</th>
                <th>Matricule</th>
              </tr>
            </thead>
            <tbody>
              {check.preview.map((p) => (
                <tr key={p.line}>
                  <td>{p.line}</td>
                  <td>{p.fullName}</td>
                  <td>{p.gender}</td>
                  <td>{formatPhone(p.guardianPhone)}</td>
                  <td>{p.matricule ?? <span className="muted">automatique</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}
    </Modal>
  );
}

function fieldErrorsList(err) {
  return Array.isArray(err?.details) ? err.details.map((d) => ({ line: null, message: d.field ? `${d.field} : ${d.message}` : d.message })) : [];
}

function StudentsTab({ api, refData, perms, notify, onLogout }) {
  const [filters, setFilters] = useState({ classId: '', q: '', status: 'active', page: 1 });
  const [query, setQuery] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // {type:'create'|'edit'|'detail'|'import', student?}
  const mobile = useIsMobile();
  const pageSize = 25;

  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === query ? f : { ...f, q: query, page: 1 })), 300);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(() => {
    api
      .listStudents({ ...filters, pageSize })
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((err) => (err.status === 401 ? onLogout('Votre session a expiré. Reconnectez-vous.') : setError(err.message)));
  }, [api, filters, onLogout]);
  useEffect(load, [load]);

  const pages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;
  const close = () => setModal(null);
  const saved = () => {
    close();
    load();
    refData.reload();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Élèves</h1>
          <div className="muted">Inscriptions, transferts et fiches individuelles</div>
        </div>
        {perms.students && (
          <div className="toolbar">
            <button className="btn btn-ghost" onClick={() => setModal({ type: 'import' })} disabled={!refData.classes.length}>
              ⇪ Importer CSV
            </button>
            <button className="btn btn-primary" onClick={() => setModal({ type: 'create' })} disabled={!refData.classes.length}>
              + Inscrire<span className="lg-only"> un élève</span>
            </button>
          </div>
        )}
      </div>
      {!refData.classes.length && perms.students && <div className="alert alert-warn">Créez d’abord une classe dans l’onglet « Classes & personnel ».</div>}

      <section className="card">
        <div className="card-head">
          <h2>Liste des élèves</h2>
          {data && <span className="count">{data.total}</span>}
          <div className="card-tools toolbar">
            <select aria-label="Classe" value={filters.classId} onChange={(e) => setFilters((f) => ({ ...f, classId: e.target.value, page: 1 }))}>
              <option value="">Toutes classes</option>
              {refData.classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select aria-label="Statut" value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value, page: 1 }))}>
              <option value="active">Inscrits</option>
              <option value="inactive">Désinscrits</option>
              <option value="all">Tous</option>
            </select>
            <input className="search" type="search" placeholder="Nom, matricule, téléphone…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Rechercher" />
          </div>
        </div>
        {error && (
          <div className="card-body">
            <div className="alert alert-error">{error}</div>
          </div>
        )}
        {!data && !error && (
          <div className="card-body">
            <div className="skeleton" style={{ height: 200 }} />
          </div>
        )}
        {data && data.students.length === 0 && (
          <div className="empty">
            <strong>Aucun élève trouvé</strong>Modifiez les filtres ou inscrivez un élève.
          </div>
        )}
        {data && data.students.length > 0 && (
          <table className="responsive compact">
            <thead>
              <tr>
                <th>Élève</th>
                <th>Classe</th>
                <th>Tuteur</th>
                <th className="num">Reste à payer</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.students.map((s) => (
                <tr
                  key={s.id}
                  className={`${s.isActive ? '' : 'inactive'} ${mobile ? 'tap' : ''}`}
                  onClick={mobile ? () => setModal({ type: 'detail', student: s }) : undefined}
                >
                  <td data-label="Élève" className="full c-main">
                    <div className="student">
                      <b>
                        <button className="link" onClick={() => setModal({ type: 'detail', student: s })}>
                          {s.fullName}
                        </button>{' '}
                        {!s.isActive && <span className="badge badge-wait">Désinscrit</span>}
                      </b>
                      <small>
                        {s.matricule} · {s.gender === 'F' ? 'F' : 'M'}
                      </small>
                    </div>
                  </td>
                  <td data-label="Classe" className="c-sub">
                    {s.className}
                  </td>
                  <td data-label="Tuteur" className="hide-sm">
                    <div className="student">
                      <span>{formatPhone(s.guardianPhone)}</span>
                      <small>{s.guardianName ?? ''}</small>
                    </div>
                  </td>
                  <td data-label="Reste à payer" className="num c-end">
                    {s.outstanding > 0 ? <span className="remaining">{formatMoney(s.outstanding)}</span> : <span className="badge badge-sms">Soldé</span>}
                  </td>
                  <td data-label="" className="full hide-sm">
                    <div className="actions">
                      <button className="btn btn-ghost btn-sm" onClick={() => setModal({ type: 'detail', student: s })}>
                        Fiche
                      </button>
                      {perms.students && (
                        <button className="btn btn-ghost btn-sm" onClick={() => setModal({ type: 'edit', student: s })}>
                          Modifier
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && data.total > pageSize && (
          <div className="pager">
            <span>
              Page {filters.page} / {pages} · {data.total} élèves
            </span>
            <div className="toolbar">
              <button className="btn btn-ghost btn-sm" disabled={filters.page <= 1} onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}>
                ← Précédent
              </button>
              <button className="btn btn-ghost btn-sm" disabled={filters.page >= pages} onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}>
                Suivant →
              </button>
            </div>
          </div>
        )}
      </section>

      {modal?.type === 'create' && (
        <StudentForm api={api} classes={refData.classes} defaultClassId={filters.classId} onClose={close} onSaved={saved} notify={notify} onLogout={onLogout} />
      )}
      {modal?.type === 'edit' && <StudentForm api={api} classes={refData.classes} student={modal.student} onClose={close} onSaved={saved} notify={notify} onLogout={onLogout} />}
      {modal?.type === 'detail' && (
        <StudentDetail
          api={api}
          studentId={modal.student.id}
          onClose={() => {
            close();
            load();
          }}
          onEdit={perms.students ? (s) => setModal({ type: 'edit', student: s }) : null}
          canEditFees={perms.fees}
          notify={notify}
          onLogout={onLogout}
        />
      )}
      {modal?.type === 'import' && (
        <ImportModal api={api} classes={refData.classes} defaultClassId={filters.classId} onClose={close} onDone={saved} notify={notify} onLogout={onLogout} />
      )}
    </>
  );
}

/* ================================================== Classes & personnel */

function ClassForm({ api, cls, teachers, onClose, onSaved, notify, onLogout }) {
  const [form, setForm] = useState({ level: cls?.level ?? '', option: cls?.option ?? '', section: cls?.section ?? '', name: cls?.name ?? '', teacherId: cls?.teacherId ?? '' });
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState('');
  const [busy, run] = useAsync(notify, onLogout);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const autoName = [form.level, form.option, form.section]
    .map((x) => x.trim())
    .filter(Boolean)
    .join(' ');

  async function submit(e) {
    e.preventDefault();
    const body = {
      level: form.level,
      option: form.option || null,
      section: form.section || null,
      teacherId: form.teacherId || null,
      name: form.name.trim() && form.name.trim() !== autoName ? form.name.trim() : cls ? autoName || null : null,
    };
    const res = await run(() => (cls ? api.updateClass(cls.id, body) : api.createClass(body)), {
      success: (r) => (cls ? `Classe « ${r.class.name} » mise à jour.` : `Classe « ${r.class.name} » créée.`),
      onError: (err) => {
        setErrors(fieldErrors(err));
        setMessage(err.message);
      },
    });
    if (res) onSaved();
  }

  return (
    <Modal
      title={cls ? `Modifier — ${cls.name}` : 'Nouvelle classe'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Annuler
          </button>
          <button className="btn btn-primary" type="submit" form="class-form" disabled={busy || !form.level.trim()}>
            {busy ? <span className="spinner" /> : 'Enregistrer'}
          </button>
        </>
      }
    >
      <form id="class-form" onSubmit={submit} noValidate>
        {message && <div className="alert alert-error">{message}</div>}
        <div className="form-grid">
          <Field id="c-level" label="Niveau" error={errors.level} hint="Ex : 1re Primaire, 4e Humanités">
            <input id="c-level" value={form.level} onChange={set('level')} autoFocus />
          </Field>
          <Field id="c-option" label="Option / section" error={errors.option} hint="Ex : Commerciale, Scientifique">
            <input id="c-option" value={form.option} onChange={set('option')} placeholder="Facultatif" />
          </Field>
          <Field id="c-section" label="Division" error={errors.section} hint="Ex : A, B">
            <input id="c-section" value={form.section} onChange={set('section')} placeholder="Facultatif" />
          </Field>
          <Field id="c-teacher" label="Titulaire" error={errors.teacherId}>
            <select id="c-teacher" value={form.teacherId} onChange={set('teacherId')}>
              <option value="">— Sans titulaire —</option>
              {teachers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.fullName}
                </option>
              ))}
            </select>
          </Field>
          <div className="span-2">
            <Field id="c-name" label="Nom affiché" error={errors.name} hint={`Laisser vide : « ${autoName || '…'} »`}>
              <input id="c-name" value={form.name === autoName ? '' : form.name} onChange={set('name')} placeholder={autoName} />
            </Field>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function UserForm({ api, user, refData, session, onClose, onSaved, notify, onLogout }) {
  const editing = Boolean(user);
  const self = editing && user.id === session.user.id;
  const roleOptions = refData.roles.filter((r) => refData.assignableRoles.includes(r.code) || r.code === user?.role);
  const defaultOffice = (role) => refData.roles.find((r) => r.code === role)?.defaultOffice ?? 'SALLE_DES_PROFS';
  const [form, setForm] = useState({
    fullName: user?.fullName ?? '',
    phone: user ? formatPhone(user.phone) : '',
    role: user?.role ?? 'TEACHER',
    office: user?.office ?? defaultOffice(user?.role ?? 'TEACHER'),
    password: '',
  });
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState('');
  const [busy, run] = useAsync(notify, onLogout);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  // Changer de rôle propose le bureau correspondant (modifiable ensuite).
  const setRole = (e) => {
    const role = e.target.value;
    setForm((f) => ({ ...f, role, office: defaultOffice(role) }));
  };

  async function submit(e) {
    e.preventDefault();
    const local = {};
    if (!form.fullName.trim()) local.fullName = 'Nom obligatoire.';
    if (!normalizePhone(form.phone)) local.phone = 'Numéro RDC invalide.';
    if ((!editing || form.password) && !isStrongPassword(form.password)) local.password = PASSWORD_HINT;
    setErrors(local);
    if (Object.keys(local).length) return;
    const body = editing
      ? {
          fullName: form.fullName,
          ...(normalizePhone(form.phone) !== user.phone ? { phone: form.phone } : {}),
          ...(form.role !== user.role ? { role: form.role } : {}),
          ...(form.office !== user.office ? { office: form.office } : {}),
          ...(form.password ? { password: form.password } : {}),
        }
      : { fullName: form.fullName, phone: form.phone, role: form.role, office: form.office, password: form.password };
    const label = refData.roles.find((r) => r.code === form.role)?.label ?? form.role;
    const res = await run(() => (editing ? api.updateUser(user.id, body) : api.createUser(body)), {
      success: editing ? 'Compte mis à jour.' : `Compte « ${label} » créé : ${form.fullName} peut se connecter avec ${form.phone}.`,
      onError: (err) => {
        setErrors(fieldErrors(err));
        setMessage(err.message);
      },
    });
    if (res) onSaved();
  }

  return (
    <Modal
      title={editing ? `Modifier — ${user.fullName}` : 'Nouveau compte du personnel'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Annuler
          </button>
          <button className="btn btn-primary" type="submit" form="user-form" disabled={busy}>
            {busy ? <span className="spinner" /> : 'Enregistrer'}
          </button>
        </>
      }
    >
      <form id="user-form" onSubmit={submit} noValidate>
        {message && <div className="alert alert-error">{message}</div>}
        <Field id="u-name" label="Nom complet" error={errors.fullName}>
          <input id="u-name" value={form.fullName} onChange={set('fullName')} autoFocus />
        </Field>
        <Field
          id="u-phone"
          label="Téléphone (identifiant de connexion)"
          error={errors.phone}
          hint={editing ? 'Modifiable : la personne se connectera ensuite avec le nouveau numéro.' : undefined}
        >
          <input id="u-phone" value={form.phone} onChange={set('phone')} inputMode="tel" placeholder="0970000000" />
        </Field>
        <div className="form-grid">
          <Field id="u-role" label="Rôle" error={errors.role} hint={self ? 'Vous ne pouvez pas modifier votre propre rôle.' : undefined}>
            <select id="u-role" value={form.role} onChange={setRole} disabled={self}>
              {roleOptions.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                  {r.code === 'TEACHER' ? ' (application mobile)' : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field id="u-office" label="Bureau" error={errors.office}>
            <select id="u-office" value={form.office} onChange={set('office')}>
              {refData.offices.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field
          id="u-pass"
          label={editing ? 'Nouveau mot de passe' : 'Mot de passe initial'}
          error={errors.password}
          hint={`${editing ? 'Laisser vide pour ne pas changer. ' : 'À communiquer en main propre. '}${PASSWORD_HINT} Stocké chiffré (bcrypt).`}
        >
          <PasswordInput id="u-pass" value={form.password} onChange={set('password')} autoComplete="new-password" />
        </Field>
      </form>
    </Modal>
  );
}

function ClassesTab({ api, refData, perms, session, notify, onLogout }) {
  const [modal, setModal] = useState(null);
  const [subject, setSubject] = useState({ name: '', defaultMaxScore: '20' });
  const [busy, run] = useAsync(notify, onLogout);
  const teachers = refData.staff.filter((u) => u.role === 'TEACHER' && u.isActive);
  const close = () => setModal(null);
  const saved = () => {
    close();
    refData.reload();
  };

  async function removeClass(c) {
    if (!window.confirm(`Supprimer la classe « ${c.name} » ?`)) return;
    if (await run(() => api.deleteClass(c.id), { success: `Classe « ${c.name} » supprimée.` })) refData.reload();
  }
  async function toggleUser(u) {
    const verb = u.isActive ? 'Désactiver' : 'Réactiver';
    if (u.isActive && !window.confirm(`${verb} le compte de ${u.fullName} ?${u.classCount ? ' Ses classes n’auront plus de titulaire.' : ''}`)) return;
    if (await run(() => api.updateUser(u.id, { isActive: !u.isActive }), { success: `Compte de ${u.fullName} ${u.isActive ? 'désactivé' : 'réactivé'}.` })) refData.reload();
  }
  async function addSubject(e) {
    e.preventDefault();
    const max = Number(subject.defaultMaxScore.replace(',', '.'));
    if (await run(() => api.createSubject({ name: subject.name, defaultMaxScore: max }), { success: `Matière « ${subject.name} » ajoutée.` })) {
      setSubject({ name: '', defaultMaxScore: '20' });
      refData.reload();
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Classes & personnel</h1>
          <div className="muted">Les enseignants retrouvent leurs classes dans l’application mobile après « Recharger ».</div>
        </div>
        {(perms.staff || perms.academic) && (
          <div className="toolbar">
            {perms.staff && (
              <button className="btn btn-ghost" onClick={() => setModal({ type: 'user' })}>
                + <span className="lg-only">Nouveau </span><span className="sm-only">Compte</span><span className="lg-only">compte</span>
              </button>
            )}
            {perms.academic && (
              <button className="btn btn-primary" onClick={() => setModal({ type: 'class' })}>
                + <span className="lg-only">Nouvelle </span><span className="sm-only">Classe</span><span className="lg-only">classe</span>
              </button>
            )}
          </div>
        )}
      </div>

      <section className="card" style={{ marginBottom: 20 }}>
        <div className="card-head">
          <h2>Classes</h2>
          <span className="count">{refData.classes.length}</span>
        </div>
        {refData.classes.length === 0 ? (
          <div className="empty">
            <strong>Aucune classe</strong>Créez la première classe de l’année.
          </div>
        ) : (
          <table className="responsive compact">
            <thead>
              <tr>
                <th>Classe</th>
                <th>Titulaire</th>
                <th className="num">Élèves</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {refData.classes.map((c) => (
                <tr key={c.id}>
                  <td data-label="Classe" className="full c-main">
                    <div className="student">
                      <b>{c.name}</b>
                      <small>{[c.level, c.option, c.section].filter(Boolean).join(' · ')}</small>
                    </div>
                  </td>
                  <td data-label="Titulaire" className="c-sub">
                    {c.teacherName ? (
                      <>
                        <span className="show-sm">Titulaire : </span>
                        {c.teacherName}
                      </>
                    ) : (
                      <span className="badge badge-amber">Sans titulaire</span>
                    )}
                  </td>
                  <td data-label="Élèves" className="num c-end">
                    <b>{c.studentCount}</b>
                    <span className="show-sm muted"> élèves</span>
                  </td>
                  <td data-label="" className="full c-act">
                    {perms.academic && (
                      <div className="actions">
                        <button className="btn btn-ghost btn-sm" onClick={() => setModal({ type: 'class', cls: c })}>
                          Modifier
                        </button>
                        {c.studentCount === 0 && (
                          <button className="btn btn-ghost btn-sm" onClick={() => removeClass(c)} disabled={busy} style={{ color: 'var(--red-600)' }}>
                            Supprimer
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card" style={{ marginBottom: 20 }}>
        <div className="card-head">
          <h2>Bureaux</h2>
          <span className="count">{refData.offices.length}</span>
        </div>
        <div className="offices">
          {refData.offices.map((o) => (
            <article className="office" key={o.code}>
              <div className="office-head">
                <b>{o.name}</b>
                <span className="badge badge-wait">{o.members} membre(s)</span>
              </div>
              <small>{o.description}</small>
              <div className="office-people">
                {refData.staff
                  .filter((u) => u.office === o.code && u.isActive)
                  .map((u) => (
                    <span className="chip" key={u.id}>
                      {u.fullName} <small className="muted">{u.roleLabel ?? ROLE_LABELS[u.role]}</small>
                    </span>
                  ))}
              </div>
            </article>
          ))}
        </div>
      </section>

      <div className="grid-2">
        <section className="card">
          <div className="card-head">
            <h2>Personnel</h2>
            <span className="count">{refData.staff.filter((u) => u.isActive).length}</span>
          </div>
          <table className="responsive compact">
            <thead>
              <tr>
                <th>Nom</th>
                <th>Rôle</th>
                <th>Bureau</th>
                <th>Téléphone</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {refData.staff.map((u) => (
                <tr key={u.id} className={u.isActive ? '' : 'inactive'}>
                  <td data-label="Nom" className="full c-main">
                    <div className="student">
                      <b>
                        {u.fullName} {!u.isActive && <span className="badge badge-wait">Désactivé</span>}
                      </b>
                      <small>{u.role === 'TEACHER' ? `${u.classCount} classe(s)` : ''}</small>
                    </div>
                  </td>
                  <td data-label="Rôle" className="c-sub">
                    {u.roleLabel ?? ROLE_LABELS[u.role]}
                    {u.officeName && <span className="show-sm"> · {u.officeName}</span>}
                  </td>
                  <td data-label="Bureau" className="hide-sm">
                    {u.officeName ?? <span className="muted">—</span>}
                  </td>
                  <td data-label="Téléphone" className="c-end">
                    <a href={`tel:${u.phone}`} className="tel-link">
                      {formatPhone(u.phone)}
                    </a>
                  </td>
                  <td data-label="" className="full c-act">
                    {perms.staff && (u.role !== 'ADMIN' || session.user.role === 'ADMIN') && (
                      <div className="actions">
                        <button className="btn btn-ghost btn-sm" onClick={() => setModal({ type: 'user', user: u })}>
                          Modifier
                        </button>
                        {u.id !== session.user.id && (
                          <button className="btn btn-ghost btn-sm" onClick={() => toggleUser(u)} disabled={busy}>
                            {u.isActive ? 'Désactiver' : 'Réactiver'}
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Matières</h2>
            <span className="count">{refData.subjects.length}</span>
          </div>
          <div className="card-body">
            {refData.subjects.map((s) => (
              <span className="chip" key={s.id}>
                {s.name} <small className="muted">/{s.defaultMaxScore}</small>
              </span>
            ))}
          </div>
          {perms.academic && (
            <form className="inline-form" onSubmit={addSubject}>
              <input
                aria-label="Nouvelle matière"
                placeholder="Nouvelle matière"
                value={subject.name}
                onChange={(e) => setSubject((s) => ({ ...s, name: e.target.value }))}
                style={{ flex: '2 1 160px' }}
              />
              <input
                aria-label="Note maximale"
                inputMode="decimal"
                value={subject.defaultMaxScore}
                onChange={(e) => setSubject((s) => ({ ...s, defaultMaxScore: e.target.value }))}
                style={{ flex: '0 1 80px' }}
                title="Note maximale par défaut"
              />
              <button className="btn btn-primary btn-sm" disabled={busy || !subject.name.trim()} style={{ height: 36 }}>
                Ajouter
              </button>
            </form>
          )}
        </section>
      </div>

      {modal?.type === 'class' && <ClassForm api={api} cls={modal.cls} teachers={teachers} onClose={close} onSaved={saved} notify={notify} onLogout={onLogout} />}
      {modal?.type === 'user' && (
        <UserForm
          api={api}
          user={modal.user}
          refData={refData}
          session={session}
          onClose={close}
          onSaved={saved}
          notify={notify}
          onLogout={onLogout}
        />
      )}
    </>
  );
}

/* ================================================================ Frais */

function BulkFeeForm({ api, classes, onClose, onSaved, notify, onLogout }) {
  const [form, setForm] = useState({ feeType: 'FRAIS_SCOLAIRES', label: '', amountDue: '', currency: 'USD', dueDate: todayIso() });
  const [selected, setSelected] = useState(() => new Set(classes.map((c) => c.id)));
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState('');
  const [busy, run] = useAsync(notify, onLogout);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggle = (id) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const studentCount = classes.filter((c) => selected.has(c.id)).reduce((s, c) => s + c.studentCount, 0);

  async function submit(e) {
    e.preventDefault();
    const amountDue = Number(String(form.amountDue).replace(',', '.'));
    const res = await run(() => api.bulkFees({ ...form, amountDue, classIds: [...selected] }), {
      success: (r) => `${r.created} frais créés${r.skipped ? ` (${r.skipped} déjà existants ignorés)` : ''}.`,
      onError: (err) => {
        setErrors(fieldErrors(err));
        setMessage(err.message);
      },
    });
    if (res) onSaved();
  }

  return (
    <Modal
      title="Nouveau frais pour une ou plusieurs classes"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Annuler
          </button>
          <button className="btn btn-primary" type="submit" form="fee-form" disabled={busy || selected.size === 0 || !form.label.trim() || !form.amountDue}>
            {busy ? <span className="spinner" /> : `Attribuer à ${studentCount} élève(s)`}
          </button>
        </>
      }
    >
      <form id="fee-form" onSubmit={submit} noValidate>
        {message && <div className="alert alert-error">{message}</div>}
        <div className="form-grid">
          <Field id="f-type" label="Type" error={errors.feeType}>
            <select id="f-type" value={form.feeType} onChange={set('feeType')}>
              {Object.entries(FEE_TYPES).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field id="f-label" label="Libellé (unique par élève)" error={errors.label}>
            <input id="f-label" value={form.label} onChange={set('label')} placeholder="Ex : Frais scolaires T3" autoFocus />
          </Field>
          <Field id="f-amount" label="Montant par élève" error={errors.amountDue}>
            <input id="f-amount" value={form.amountDue} onChange={set('amountDue')} inputMode="decimal" placeholder="60" />
          </Field>
          <Field id="f-cur" label="Devise" error={errors.currency}>
            <select id="f-cur" value={form.currency} onChange={set('currency')}>
              <option value="USD">Dollar (USD)</option>
              <option value="CDF">Franc congolais (CDF)</option>
            </select>
          </Field>
          <Field id="f-due" label="Échéance" error={errors.dueDate}>
            <input id="f-due" type="date" value={form.dueDate} onChange={set('dueDate')} />
          </Field>
        </div>
        <div className="field">
          <label>
            Classes concernées ·{' '}
            <button type="button" className="link" onClick={() => setSelected(new Set(selected.size === classes.length ? [] : classes.map((c) => c.id)))}>
              {selected.size === classes.length ? 'aucune' : 'toutes'}
            </button>
          </label>
        </div>
        <div className="checks">
          {classes.map((c) => (
            <label key={c.id}>
              <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
              {c.name} <span className="muted">({c.studentCount})</span>
            </label>
          ))}
        </div>
        <div className="hint">Un élève qui possède déjà un frais portant ce libellé pour l’année n’est pas facturé deux fois.</div>
      </form>
    </Modal>
  );
}

function FeesTab({ api, refData, perms, notify, onLogout }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    api
      .feeSummary()
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((err) => (err.status === 401 ? onLogout('Votre session a expiré. Reconnectez-vous.') : setError(err.message)));
  }, [api, onLogout]);
  useEffect(load, [load]);

  const totals = useMemo(() => {
    const t = {};
    for (const p of data?.plans ?? []) {
      t[p.currency] ??= { due: 0, paid: 0 };
      t[p.currency].due += p.due;
      t[p.currency].paid += p.paid;
    }
    return t;
  }, [data]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Frais scolaires</h1>
          <div className="muted">Année {data?.schoolYear ?? '…'} · élèves inscrits uniquement · remises et reports depuis la fiche de l’élève</div>
        </div>
        {perms.fees && (
          <button className="btn btn-primary" onClick={() => setOpen(true)} disabled={!refData.classes.length}>
            + Nouveau frais
          </button>
        )}
      </div>

      <div className="kpis fees-kpis">
        {Object.entries(totals).map(([cur, t]) => (
          <div className="kpi green" key={cur}>
            <span className="kpi-label">Recouvrement {cur}</span>
            <span className="kpi-value">{formatPct(t.due ? t.paid / t.due : null)}</span>
            <div className="bar green">
              <span style={{ width: `${t.due ? Math.min(100, (t.paid / t.due) * 100) : 0}%` }} />
            </div>
            <span className="kpi-foot">
              {formatMoney(t.paid, cur)} encaissés sur {formatMoney(t.due, cur)}
            </span>
          </div>
        ))}
        {data && (
          <div className="kpi red">
            <span className="kpi-label">Frais insolvables</span>
            <span className="kpi-value">{data.plans.reduce((s, p) => s + p.insolvable, 0)}</span>
            <span className="kpi-foot">échéance dépassée et non soldés</span>
          </div>
        )}
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Synthèse par frais</h2>
          {data && <span className="count">{data.plans.length}</span>}
        </div>
        {error && (
          <div className="card-body">
            <div className="alert alert-error">{error}</div>
          </div>
        )}
        {!data && !error && (
          <div className="card-body">
            <div className="skeleton" style={{ height: 160 }} />
          </div>
        )}
        {data && data.plans.length === 0 && (
          <div className="empty">
            <strong>Aucun frais pour cette année</strong>Créez les frais d’inscription et les tranches trimestrielles.
          </div>
        )}
        {data && data.plans.length > 0 && (
          <table className="responsive">
            <thead>
              <tr>
                <th>Frais</th>
                <th>Échéance</th>
                <th className="num">Élèves</th>
                <th className="num">Attendu</th>
                <th className="num">Encaissé</th>
                <th style={{ minWidth: 140 }}>Recouvrement</th>
                <th>Statuts</th>
              </tr>
            </thead>
            <tbody>
              {data.plans.map((p) => (
                <tr key={`${p.label}-${p.currency}-${p.dueDate}`}>
                  <td data-label="Frais" className="full">
                    <div className="student">
                      <b>{p.label}</b>
                      <small>{FEE_TYPES[p.feeType] ?? p.feeType}</small>
                    </div>
                  </td>
                  <td data-label="Échéance">{formatShortDate(p.dueDate)}</td>
                  <td data-label="Élèves" className="num">
                    {p.students}
                  </td>
                  <td data-label="Attendu" className="num">
                    {formatMoney(p.due, p.currency)}
                  </td>
                  <td data-label="Encaissé" className="num">
                    {formatMoney(p.paid, p.currency)}
                  </td>
                  <td data-label="Recouvrement">
                    <div style={{ display: 'grid', gap: 4 }}>
                      <small>{formatPct(p.recoveryRate)}</small>
                      <div className={`bar ${p.recoveryRate >= 0.75 ? 'green' : p.insolvable ? 'red' : ''}`}>
                        <span style={{ width: `${Math.min(100, (p.recoveryRate ?? 0) * 100)}%` }} />
                      </div>
                    </div>
                  </td>
                  <td data-label="Statuts" className="full">
                    <span className="badge badge-sms">{p.solde} soldé(s)</span> {p.enCours > 0 && <span className="badge badge-amber">{p.enCours} en cours</span>}{' '}
                    {p.insolvable > 0 && <span className="badge badge-red">{p.insolvable} insolvable(s)</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {open && (
        <BulkFeeForm
          api={api}
          classes={refData.classes}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            load();
          }}
          notify={notify}
          onLogout={onLogout}
        />
      )}
    </>
  );
}

/* ========================================================== Point d'entrée */

export const ADMIN_TABS = [
  { id: 'students', label: 'Élèves', short: 'Élèves', icon: 'students' },
  { id: 'classes', label: 'Classes & personnel', short: 'Classes', icon: 'classes' },
  { id: 'fees', label: 'Frais', short: 'Frais', icon: 'fees' },
];

export function AdminView({ tab, session, notify, onLogout, onSlow }) {
  const api = useMemo(() => createAdminApi(session.token, onSlow), [session.token, onSlow]);
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState('');
  const perms = {
    staff: can(session.user, 'MANAGE_STAFF'),
    academic: can(session.user, 'MANAGE_ACADEMIC'),
    students: can(session.user, 'MANAGE_STUDENTS'),
    fees: can(session.user, 'MANAGE_FEES'),
  };

  const reload = useCallback(() => {
    api
      .overview()
      .then((d) => {
        setOverview(d);
        setError('');
      })
      .catch((err) => (err.status === 401 ? onLogout('Votre session a expiré. Reconnectez-vous.') : setError(err.message)));
  }, [api, onLogout]);
  useEffect(reload, [reload]);

  if (error && !overview) return <div className="alert alert-error">{error}</div>;
  if (!overview) return <div className="skeleton" style={{ height: 320 }} />;

  const refData = { ...overview, reload };
  const props = { api, refData, notify, onLogout, session, perms };
  if (tab === 'students') return <StudentsTab {...props} />;
  if (tab === 'classes') return <ClassesTab {...props} />;
  return <FeesTab {...props} />;
}
