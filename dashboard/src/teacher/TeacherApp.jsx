import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { normalizePhone } from '../lib.js';
import { PASSWORD_CSS, PasswordInput } from '../ui.jsx';
import {
  EVALUATIONS,
  MAX_PAST_DAYS,
  SyncEngine,
  TERMS,
  acknowledgeAlert,
  attendanceFor,
  classGrades,
  formatScore,
  gradesFor,
  isExpired,
  loadBootstrap,
  login as apiLogin,
  parseScore,
  readSession,
  refreshAlerts,
  refreshBootstrap,
  saveAttendance,
  saveGrade,
  shiftIso,
  studentName,
  todayIso,
  writeSession,
  clearLocalData,
} from './store.js';
import { PASS_PCT, SIGNAL_LABELS, classReport } from './averages.js';

/* =============================================================================
   ESPACE ENSEIGNANT — application web installable (iPhone, Android, ordinateur)
   - Installation : Safari → Partager → « Sur l'écran d'accueil » (iPhone),
     ou bouton « Installer » (Android / ordinateur)
   - Appel et cotes enregistrés sur l'appareil, même sans réseau, puis envoyés
     automatiquement (file d'attente) — même fonctionnement que l'app Android
   - Moyennes calculées automatiquement et élèves en difficulté signalés
     (moyenne < 50 %, baisse ≥ 10 points, deux échecs de suite)
   ============================================================================= */

const CSS = `
:root{--navy:#0B2545;--navy2:#1D4E89;--green:#1B7F3B;--red:#C62828;--orange:#E67E00;--grey:#5B6B82;--line:#E3E8F0;--bg:#F4F6FA}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:#13233A;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%}
button,input,select{font:inherit}
button{cursor:pointer;-webkit-tap-highlight-color:transparent}
.app{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;padding-bottom:env(safe-area-inset-bottom)}
.top{position:sticky;top:0;z-index:20;background:var(--navy);color:#fff;padding:calc(env(safe-area-inset-top) + 10px) 14px 10px;display:flex;align-items:center;gap:10px;box-shadow:0 2px 10px rgba(0,0,0,.15)}
.top h1{font-size:17px;margin:0;line-height:1.2;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.top small{display:block;font-size:12px;font-weight:400;color:#C9D6EA}
.icon-btn{background:rgba(255,255,255,.12);border:0;color:#fff;width:40px;height:40px;border-radius:10px;display:grid;place-items:center;font-size:20px;flex:none}
.pill{font-size:12px;font-weight:600;padding:5px 10px;border-radius:999px;background:rgba(255,255,255,.14);white-space:nowrap;flex:none;border:0;color:#fff}
.pill.off{background:#7A2E2E}.pill.wait{background:#8A5300}.pill.ok{background:#1E5B34}
main{flex:1;padding:14px;max-width:760px;width:100%;margin:0 auto}
.card{background:#fff;border-radius:14px;box-shadow:0 1px 3px rgba(11,37,69,.08);padding:14px;margin-bottom:12px}
.card h2{font-size:16px;margin:0 0 6px}
.muted{color:var(--grey);font-size:13px}
.btn{border:0;border-radius:12px;padding:12px 16px;font-weight:600;font-size:15px;min-height:46px}
.btn-primary{background:var(--navy);color:#fff}
.btn-ghost{background:#EEF2F8;color:var(--navy)}
.btn-green{background:var(--green);color:#fff}
.btn-block{width:100%}
.btn:disabled{opacity:.55}
.row-actions{display:flex;gap:8px;margin-top:10px}
.row-actions .btn{flex:1}
.alert{border-radius:12px;padding:10px 12px;font-size:14px;margin-bottom:12px}
.alert-error{background:#FDECEC;color:#8E1F1F}
.alert-warn{background:#FFF4E0;color:#7A4A00}
.alert-info{background:#E8F0FB;color:#123E73}
.field{margin-bottom:14px}
.field label{display:block;font-size:13px;font-weight:600;margin-bottom:6px}
.field input,.field select{width:100%;height:48px;border:1px solid #C9D3E1;border-radius:12px;padding:0 12px;font-size:16px;background:#fff;color:#13233A}
.login{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;background:linear-gradient(160deg,#0B2545,#1D4E89)}
.login-head{color:#fff;padding:calc(env(safe-area-inset-top) + 36px) 24px 26px}
.login-head h1{margin:12px 0 4px;font-size:26px}
.login-head p{margin:0;color:#C9D6EA}
.login-card{background:#fff;border-radius:22px 22px 0 0;padding:24px 20px calc(env(safe-area-inset-bottom) + 24px);flex:1}
.logo{width:56px;height:56px;border-radius:14px;background:#fff;display:grid;place-items:center}
.stats{display:flex;gap:8px;margin:4px 0 12px}
.stat{flex:1;background:#fff;border-radius:12px;padding:10px;text-align:center;box-shadow:0 1px 3px rgba(11,37,69,.08)}
.stat b{display:block;font-size:22px}
.stat span{font-size:12px;color:var(--grey)}
.list{background:#fff;border-radius:14px;box-shadow:0 1px 3px rgba(11,37,69,.08);overflow:hidden}
.item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--line);min-height:62px}
.item:last-child{border-bottom:0}
.item .who{flex:1;min-width:0}
.item .who b{display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.item .who small{font-size:12px;color:var(--grey)}
.seg{display:flex;border-radius:10px;overflow:hidden;border:1px solid #C9D3E1;flex:none}
.seg button{border:0;background:#fff;width:52px;height:42px;font-weight:700;color:var(--grey);font-size:15px}
.seg button.p[aria-pressed=true]{background:var(--green);color:#fff}
.seg button.a[aria-pressed=true]{background:var(--red);color:#fff}
.st{width:22px;text-align:center;flex:none;font-size:15px}
.st.pending{color:var(--orange)}.st.synced{color:var(--green)}.st.rejected{color:var(--red)}
.score{width:84px;height:44px;border:1px solid #C9D3E1;border-radius:10px;text-align:center;font-size:17px;flex:none}
.score.err{border-color:var(--red);background:#FFF5F5}
.err-text{color:var(--red);font-size:12px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.class-card .meta{display:flex;justify-content:space-between;align-items:center}
.badge{font-size:12px;font-weight:600;padding:3px 8px;border-radius:999px;background:#EEF2F8;color:var(--navy)}
.install{background:#fff;border:1px solid #CFE0F5;border-radius:14px;padding:12px 14px;margin-bottom:12px;font-size:14px;display:flex;gap:10px;align-items:flex-start}
.install b{display:block;margin-bottom:2px}
.install .x{margin-left:auto;background:none;border:0;font-size:20px;color:var(--grey);padding:0 4px}
.share{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:6px;background:#E8F0FB;vertical-align:-5px}
.sticky-foot{position:sticky;bottom:0;padding:10px 0 calc(env(safe-area-inset-bottom) + 6px);background:linear-gradient(transparent,var(--bg) 30%)}
.spinner{display:inline-block;width:18px;height:18px;border:2.5px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite;vertical-align:-4px;margin-right:8px}
@keyframes spin{to{transform:rotate(360deg)}}
.center{text-align:center;padding:40px 16px}
.warn-card{background:#FFF4E0;border:1px solid #F6C77A;border-radius:14px;padding:12px 14px;margin-bottom:12px}
.warn-card h2{font-size:15px;margin:0 0 6px;color:#7A4A00}
.warn-card ul{margin:6px 0 8px;padding-left:18px;font-size:13px;color:#5C3A00;line-height:1.45}
.badge-warn{background:#FDECEC;color:var(--red)}
.avg{font-weight:700;font-variant-numeric:tabular-nums}
.avg.low{color:var(--red)}.avg.ok{color:var(--green)}
.stat b .avg{font-size:inherit}
.avg-big{font-size:20px;flex:none;min-width:58px;text-align:right}
.chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.chip{font-size:11px;font-weight:700;padding:2px 7px;border-radius:999px;background:#EEF2F8;color:var(--navy)}
.chip.low{background:#FDECEC;color:var(--red)}
.chip.sig{background:#FDECEC;color:var(--red)}
.chip.sig.CHUTE{background:#FFF4E0;color:#8A5300}
.item.flag{background:#FFFBF5;border-left:4px solid var(--orange)}
.item.col{flex-direction:column;align-items:stretch}
.item.col .line{display:flex;align-items:center;gap:10px}
.reason{font-size:12px;color:#5C3A00;margin-top:4px;line-height:1.4}
.followed{font-size:12px;color:var(--green);font-weight:600}
.tabs-term{display:flex;gap:6px;margin-bottom:10px}
.tabs-term button{flex:1;border:1px solid #C9D3E1;background:#fff;border-radius:10px;height:42px;font-weight:600;color:var(--grey)}
.tabs-term button[aria-pressed=true]{background:var(--navy);border-color:var(--navy);color:#fff}
.btn-sm{min-height:38px;padding:8px 12px;font-size:13px;border-radius:10px}
.sub-avg{display:block;font-size:12px;color:var(--grey)}
`;

const Logo = () => (
  <svg width="36" height="36" viewBox="0 0 64 64" aria-hidden="true">
    <path d="M32 12 6 25l26 13 22-11v15h4V25z" fill="#0B2545" />
    <path d="M17 34v10c0 4.5 6.7 8 15 8s15-3.5 15-8V34l-15 7.5z" fill="#1D4E89" />
  </svg>
);

const SYNC_ICON = { pending: '☁', synced: '✓', rejected: '!' };
const SYNC_LABEL = { pending: 'En attente d’envoi', synced: 'Enregistré sur le serveur', rejected: 'Refusé' };

function SyncMark({ row }) {
  if (!row) return <span className="st" aria-hidden="true" />;
  const title = row.sync === 'rejected' ? `Refusé : ${row.error}` : SYNC_LABEL[row.sync];
  return (
    <span className={`st ${row.sync}`} title={title} aria-label={title} role="img">
      {SYNC_ICON[row.sync]}
    </span>
  );
}

const formatWhen = (iso) =>
  iso ? new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lubumbashi' }).format(new Date(iso)) : 'jamais';
const formatDay = (iso) => new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));

/* ------------------------------------------------------ Aide à l'installation */

function useInstallPrompt() {
  const [deferred, setDeferred] = useState(null);
  useEffect(() => {
    const onPrompt = (e) => {
      e.preventDefault();
      setDeferred(e);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);
  return deferred;
}

function InstallHint() {
  const deferred = useInstallPrompt();
  const [hidden, setHidden] = useState(() => localStorage.getItem('schoolap.enseignant.installHint') === 'masque');
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (standalone || hidden || (!ios && !deferred)) return null;
  const close = () => {
    localStorage.setItem('schoolap.enseignant.installHint', 'masque');
    setHidden(true);
  };
  return (
    <div className="install" role="note">
      <div>
        <b>Installer l’application sur ce téléphone</b>
        {ios ? (
          <>
            Dans Safari, touchez{' '}
            <span className="share" aria-label="Partager">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1D4E89" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3v12M7 8l5-5 5 5" />
                <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
              </svg>
            </span>{' '}
            <b style={{ display: 'inline' }}>Partager</b>, puis <b style={{ display: 'inline' }}>« Sur l’écran d’accueil »</b>. L’icône s’ouvrira en plein écran, même sans réseau.
          </>
        ) : (
          <>
            Ajoutez l’Espace Enseignant à l’écran d’accueil pour l’ouvrir comme une application, même sans réseau.
            <div className="row-actions">
              <button
                className="btn btn-primary"
                onClick={async () => {
                  deferred.prompt();
                  await deferred.userChoice;
                  close();
                }}
              >
                Installer
              </button>
            </div>
          </>
        )}
      </div>
      <button className="x" onClick={close} aria-label="Masquer">
        ×
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------- Connexion */

function LoginScreen({ onLogin, expiredUser }) {
  const [phone, setPhone] = useState(expiredUser?.phone ? `0${expiredUser.phone.slice(4)}` : '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!normalizePhone(phone)) {
      setError('Numéro invalide. Exemple : 0970000002.');
      return;
    }
    setBusy(true);
    const t = setTimeout(() => setSlow(true), 4000);
    try {
      await onLogin(phone, password);
    } catch (err) {
      setError(err.status === 401 ? 'Téléphone ou mot de passe incorrect.' : err.message);
    } finally {
      clearTimeout(t);
      setSlow(false);
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login-head">
        <div className="logo">
          <Logo />
        </div>
        <h1>Espace Enseignant</h1>
        <p>Appel et cotes, même sans réseau</p>
      </div>
      <form className="login-card" onSubmit={submit} noValidate>
        <InstallHint />
        {expiredUser && (
          <div className="alert alert-warn">
            Votre session a expiré. Les saisies non envoyées sont conservées sur ce téléphone : reconnectez-vous pour les envoyer.
          </div>
        )}
        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}
        {slow && <div className="alert alert-info">Le serveur se réveille… cela peut prendre jusqu’à une minute.</div>}
        <div className="field">
          <label htmlFor="phone">Téléphone</label>
          <input id="phone" type="tel" inputMode="tel" autoComplete="username" placeholder="0970000002" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="password">Mot de passe</label>
          <PasswordInput id="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button className="btn btn-primary btn-block" type="submit" disabled={busy || !phone || !password}>
          {busy && <span className="spinner" aria-hidden="true" />}
          {busy ? 'Connexion…' : 'Se connecter'}
        </button>
        <p className="muted" style={{ marginTop: 18, textAlign: 'center' }}>
          Compte créé par la direction de l’école. Mot de passe oublié : adressez-vous au Préfet ou au Directeur.
        </p>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------- Barre du haut */

function TopBar({ title, subtitle, onBack, sync, onSyncTap }) {
  let pill = { cls: 'ok', text: '✓ À jour' };
  if (!sync.online) pill = { cls: 'off', text: sync.pending ? `Hors ligne · ${sync.pending}` : 'Hors ligne' };
  else if (sync.syncing) pill = { cls: 'wait', text: 'Envoi…' };
  else if (sync.pending) pill = { cls: 'wait', text: `☁ ${sync.pending} en attente` };
  return (
    <header className="top">
      {onBack && (
        <button className="icon-btn" onClick={onBack} aria-label="Retour">
          ‹
        </button>
      )}
      <h1>
        {title}
        {subtitle && <small>{subtitle}</small>}
      </h1>
      <button className={`pill ${pill.cls}`} onClick={onSyncTap} aria-label={`Synchronisation : ${pill.text}`}>
        {pill.text}
      </button>
    </header>
  );
}

/* ------------------------------------------------------------------ Accueil */

function Home({ session, bootstrap, sync, engine, refreshing, refreshError, onRefresh, onOpen, onLogout, reports }) {
  const canGrade = session.user.permissions?.includes('ENTER_GRADES');
  const struggling = (bootstrap?.classes ?? []).flatMap((c) => (reports.get(c.id)?.struggling ?? []).map((s) => ({ ...s, cls: c })));
  const toHandle = struggling.filter((s) => s.signals.some((x) => x.server?.status !== 'ACKNOWLEDGED'));
  return (
    <main>
      <InstallHint />
      <div className="card">
        <h2>Bonjour {session.user.fullName}</h2>
        <div className="muted">
          {session.user.roleLabel ?? 'Enseignant'} · {bootstrap?.school?.name ?? session.school?.name}
        </div>
        <div className="muted" style={{ marginTop: 6 }}>
          {sync.pending ? `${sync.pending} saisie(s) en attente d’envoi` : 'Toutes les saisies sont envoyées'} · dernière synchronisation : {formatWhen(sync.lastSyncAt)}
        </div>
        {sync.rejected > 0 && <div className="err-text" style={{ marginTop: 6 }}>{sync.rejected} saisie(s) refusée(s) par le serveur : repérez le « ! » rouge et corrigez.</div>}
        {sync.lastError && sync.pending > 0 && <div className="err-text" style={{ marginTop: 6 }}>Dernière erreur : {sync.lastError}</div>}
        <div className="row-actions">
          <button className="btn btn-ghost" onClick={() => engine.run()} disabled={sync.syncing || !sync.online}>
            Envoyer maintenant
          </button>
          <button className="btn btn-ghost" onClick={onRefresh} disabled={refreshing || !sync.online}>
            {refreshing ? 'Chargement…' : 'Recharger les listes'}
          </button>
        </div>
        {refreshError && <div className="err-text" style={{ marginTop: 8 }}>{refreshError}</div>}
      </div>

      {toHandle.length > 0 && (
        <div className="warn-card" role="status">
          <h2>⚠ {toHandle.length} élève(s) en difficulté</h2>
          <div className="muted" style={{ color: '#7A4A00' }}>
            Résultats en baisse : intervenez avant la fin de l’année. Le tuteur est prévenu une fois par SMS à chaque nouvelle baisse.
          </div>
          <ul>
            {toHandle.slice(0, 4).map((s) => (
              <li key={s.student.id}>
                <b>{studentName(s.student)}</b> ({s.cls.name}) — {s.signals[0].summary}
                {s.signals.length > 1 ? ` (+${s.signals.length - 1})` : ''}
              </li>
            ))}
            {toHandle.length > 4 && <li>… et {toHandle.length - 4} autre(s)</li>}
          </ul>
          {bootstrap.classes.length === 1 ? (
            <button className="btn btn-primary btn-block" onClick={() => onOpen('results', bootstrap.classes[0].id)}>
              Voir les moyennes et les élèves à aider
            </button>
          ) : (
            <div className="muted" style={{ color: '#7A4A00' }}>
              Touchez « Moyennes » sur la classe concernée.
            </div>
          )}
        </div>
      )}

      {!bootstrap ? (
        <div className="card center">
          <b>Aucune liste sur ce téléphone</b>
          <p className="muted">Connectez-vous à Internet puis touchez « Recharger les listes » pour télécharger vos classes. Vous pourrez ensuite travailler sans réseau.</p>
        </div>
      ) : bootstrap.classes.length === 0 ? (
        <div className="card center">
          <b>Aucune classe attribuée</b>
          <p className="muted">La direction doit vous désigner titulaire d’une classe (Classes &amp; personnel → Modifier). Touchez ensuite « Recharger les listes ».</p>
        </div>
      ) : (
        bootstrap.classes.map((c) => (
          <div className="card class-card" key={c.id}>
            <div className="meta">
              <h2 style={{ margin: 0 }}>{c.name}</h2>
              <span style={{ display: 'flex', gap: 6 }}>
                {(reports.get(c.id)?.struggling.length ?? 0) > 0 && <span className="badge badge-warn">⚠ {reports.get(c.id).struggling.length} en difficulté</span>}
                <span className="badge">{c.students.length} élèves</span>
              </span>
            </div>
            <div className="row-actions">
              <button className="btn btn-primary" onClick={() => onOpen('attendance', c.id)}>
                Faire l’appel
              </button>
              {canGrade && (
                <button className="btn btn-ghost" onClick={() => onOpen('grades', c.id)}>
                  Saisir les cotes
                </button>
              )}
            </div>
            <button className="btn btn-ghost btn-block" style={{ marginTop: 8 }} onClick={() => onOpen('results', c.id)}>
              Moyennes et élèves en difficulté
            </button>
          </div>
        ))
      )}

      <button className="btn btn-ghost btn-block" style={{ marginTop: 8 }} onClick={onLogout}>
        Se déconnecter
      </button>
      <p className="muted" style={{ textAlign: 'center', marginTop: 14 }}>
        Listes du {bootstrap ? formatWhen(bootstrap.fetchedAt) : '—'}
      </p>
    </main>
  );
}

/* -------------------------------------------------------------------- Appel */

function AttendanceScreen({ cls, engine, sync }) {
  const today = todayIso();
  const [date, setDate] = useState(today);
  const [entries, setEntries] = useState(new Map());
  const students = cls.students;

  const reload = useCallback(async () => setEntries(await attendanceFor(cls.id, date)), [cls.id, date]);
  useEffect(() => {
    reload();
  }, [reload, sync.syncing, sync.pending]);

  async function mark(student, status) {
    const row = await saveAttendance({ studentId: student.id, classId: cls.id, date, status });
    setEntries((m) => new Map(m).set(student.id, row));
    engine.notifyLocalChange();
  }
  async function markRemaining() {
    for (const s of students.filter((x) => !entries.has(x.id))) {
      await saveAttendance({ studentId: s.id, classId: cls.id, date, status: 'PRESENT' });
    }
    await reload();
    engine.notifyLocalChange();
  }

  const present = students.filter((s) => entries.get(s.id)?.status === 'PRESENT').length;
  const absent = students.filter((s) => entries.get(s.id)?.status === 'ABSENT').length;
  const remaining = students.length - present - absent;

  return (
    <main>
      <div className="field">
        <label htmlFor="date">Date de l’appel</label>
        <input id="date" type="date" value={date} min={shiftIso(today, -MAX_PAST_DAYS)} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} />
        <div className="muted" style={{ marginTop: 4 }}>
          {formatDay(date)}
        </div>
      </div>
      <div className="stats">
        <div className="stat">
          <b style={{ color: 'var(--green)' }}>{present}</b>
          <span>Présents</span>
        </div>
        <div className="stat">
          <b style={{ color: 'var(--red)' }}>{absent}</b>
          <span>Absents</span>
        </div>
        <div className="stat">
          <b>{remaining}</b>
          <span>Restants</span>
        </div>
      </div>
      <div className="list">
        {students.map((s, i) => {
          const e = entries.get(s.id);
          return (
            <div className="item" key={s.id}>
              <div className="who">
                <b>
                  {i + 1}. {studentName(s)}
                </b>
                <small>
                  {s.matricule}
                  {e?.status === 'ABSENT' && e.smsStatus === 'sent' ? ' · SMS envoyé au tuteur' : ''}
                  {e?.sync === 'rejected' ? <span className="err-text"> · {e.error}</span> : null}
                </small>
              </div>
              <div className="seg" role="group" aria-label={`Présence de ${studentName(s)}`}>
                <button className="p" aria-pressed={e?.status === 'PRESENT'} onClick={() => mark(s, 'PRESENT')}>
                  P
                </button>
                <button className="a" aria-pressed={e?.status === 'ABSENT'} onClick={() => mark(s, 'ABSENT')}>
                  A
                </button>
              </div>
              <SyncMark row={e} />
            </div>
          );
        })}
      </div>
      {remaining > 0 && (
        <div className="sticky-foot">
          <button className="btn btn-green btn-block" onClick={markRemaining}>
            Marquer les {remaining} restants présents
          </button>
        </div>
      )}
      <p className="muted" style={{ textAlign: 'center' }}>
        ☁ en attente · ✓ envoyé · un SMS est envoyé automatiquement au tuteur de chaque absent.
      </p>
    </main>
  );
}

/* -------------------------------------------------------------------- Cotes */

function Avg({ value, className = '' }) {
  if (value == null) return <span className={`avg ${className}`}>—</span>;
  return <span className={`avg ${value < PASS_PCT ? 'low' : 'ok'} ${className}`}>{Math.round(value)} %</span>;
}

function GradesScreen({ cls, subjects, engine, sync }) {
  const [subjectId, setSubjectId] = useState(subjects[0]?.id ?? '');
  const [term, setTerm] = useState('T1');
  const [evaluation, setEvaluation] = useState(EVALUATIONS[0]);
  const [max, setMax] = useState(String(subjects[0]?.defaultMaxScore ?? 20));
  const [grades, setGrades] = useState(new Map());
  const [values, setValues] = useState({});
  const [errors, setErrors] = useState({});
  const inputs = useRef({});
  const [allGrades, setAllGrades] = useState([]);
  const selection = useMemo(() => ({ classId: cls.id, subjectId, term, evaluation }), [cls.id, subjectId, term, evaluation]);

  // Moyenne automatique de l'élève dans la matière et la période choisies (toutes évaluations confondues).
  useEffect(() => {
    classGrades(cls.id).then(setAllGrades);
  }, [cls.id, grades, sync.syncing]);
  const subjectAvg = useMemo(() => {
    const out = new Map();
    for (const s of cls.students) {
      const list = allGrades.filter((g) => g.studentId === s.id && g.subjectId === subjectId && g.term === term);
      let score = 0;
      let maxTotal = 0;
      for (const g of list) {
        score += g.score;
        maxTotal += g.maxScore;
      }
      out.set(s.id, maxTotal > 0 ? { pct: (score / maxTotal) * 100, n: list.length } : null);
    }
    return out;
  }, [allGrades, cls.students, subjectId, term]);

  useEffect(() => {
    let alive = true;
    gradesFor(selection).then((g) => {
      if (!alive) return;
      setGrades(g);
      setValues(Object.fromEntries(cls.students.map((s) => [s.id, g.has(s.id) ? formatScore(g.get(s.id).score) : ''])));
      setErrors({});
      const first = g.values().next().value;
      if (first) setMax(formatScore(first.maxScore));
    });
    return () => {
      alive = false;
    };
  }, [selection, cls.students]);

  // Après un envoi, seules les icônes d'état sont rafraîchies (les saisies en cours ne bougent pas).
  useEffect(() => {
    gradesFor(selection).then(setGrades);
  }, [sync.syncing, sync.pending, selection]);

  const maxScore = parseScore(max);

  async function commit(student) {
    const text = values[student.id] ?? '';
    let error = null;
    const score = parseScore(text);
    if (text.trim() === '') error = null;
    else if (!maxScore || maxScore > 1000) error = 'Note max invalide';
    else if (score === null) error = 'Nombre attendu';
    else if (score > maxScore) error = `0 à ${formatScore(maxScore)}`;
    setErrors((e) => ({ ...e, [student.id]: error }));
    if (error || score === null || !subjectId) return;
    const existing = grades.get(student.id);
    if (existing && existing.score === score && existing.maxScore === maxScore) return;
    const row = await saveGrade({ studentId: student.id, classId: cls.id, subjectId, term, evaluation, maxScore, score });
    setGrades((m) => new Map(m).set(student.id, row));
    engine.notifyLocalChange();
  }

  function next(i) {
    const nextStudent = cls.students[i + 1];
    if (nextStudent) inputs.current[nextStudent.id]?.focus();
    else document.activeElement?.blur();
  }

  if (!subjects.length) return <main className="center muted">Aucune matière définie : demandez à la direction d’en ajouter.</main>;

  const done = cls.students.filter((s) => grades.has(s.id)).length;
  return (
    <main>
      <div className="card">
        <div className="field">
          <label htmlFor="subject">Matière</label>
          <select
            id="subject"
            value={subjectId}
            onChange={(e) => {
              setSubjectId(e.target.value);
              const s = subjects.find((x) => x.id === e.target.value);
              if (s) setMax(formatScore(s.defaultMaxScore));
            }}
          >
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid2">
          <div className="field">
            <label htmlFor="term">Période</label>
            <select id="term" value={term} onChange={(e) => setTerm(e.target.value)}>
              {TERMS.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="evaluation">Évaluation</label>
            <select id="evaluation" value={evaluation} onChange={(e) => setEvaluation(e.target.value)}>
              {EVALUATIONS.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="max">Note maximale</label>
          <input id="max" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} />
        </div>
      </div>
      <div className="muted" style={{ margin: '0 4px 8px' }}>
        {done}/{cls.students.length} cotes saisies · enregistrement automatique en quittant chaque case
      </div>
      <div className="list">
        {cls.students.map((s, i) => (
          <div className="item" key={s.id}>
            <div className="who">
              <b>
                {i + 1}. {studentName(s)}
              </b>
              {subjectAvg.get(s.id) && (
                <small className="sub-avg">
                  Moyenne {term} : <Avg value={subjectAvg.get(s.id).pct} /> ({subjectAvg.get(s.id).n} cote{subjectAvg.get(s.id).n > 1 ? 's' : ''})
                </small>
              )}
              {errors[s.id] && <small className="err-text">{errors[s.id]}</small>}
              {grades.get(s.id)?.sync === 'rejected' && <small className="err-text">{grades.get(s.id).error}</small>}
            </div>
            <input
              ref={(el) => {
                inputs.current[s.id] = el;
              }}
              className={`score ${errors[s.id] ? 'err' : ''}`}
              inputMode="decimal"
              enterKeyHint={i + 1 < cls.students.length ? 'next' : 'done'}
              aria-label={`Cote de ${studentName(s)} sur ${max}`}
              placeholder={`/${max || '?'}`}
              value={values[s.id] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [s.id]: e.target.value }))}
              onBlur={() => commit(s)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commit(s);
                  next(i);
                }
              }}
            />
            <SyncMark row={grades.get(s.id)} />
          </div>
        ))}
      </div>
    </main>
  );
}

/* ----------------------------------------------------------- Moyennes */

function ResultsScreen({ cls, subjects, report, session, online, onAcknowledged }) {
  const [term, setTerm] = useState(null);
  const [onlyStruggling, setOnlyStruggling] = useState(report.struggling.length > 0);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const terms = report.termsWithGrades;
  const current = term && terms.includes(term) ? term : terms[terms.length - 1];
  const subjectName = new Map(subjects.map((s) => [s.id, s.name]));

  async function acknowledge(alert, student) {
    const note = window.prompt(`Prise en charge de ${studentName(student)}.\nSuite donnée (facultatif) : parent convoqué, remédiation…`, '');
    if (note === null) return;
    setBusy(alert.id);
    setError('');
    try {
      await onAcknowledged(alert.id, note.trim().slice(0, 300));
    } catch (err) {
      setError(err.status === 0 ? 'Pas de réseau : réessayez quand la connexion revient.' : err.message);
    } finally {
      setBusy(null);
    }
  }

  if (!terms.length)
    return (
      <main className="center muted">
        Aucune cote pour cette classe. Les moyennes se calculent automatiquement dès la saisie des premières cotes.
      </main>
    );

  const rows = report.students
    .filter((r) => !onlyStruggling || r.signals.length > 0)
    .sort((a, b) => b.signals.length - a.signals.length || (a.averages.terms[current]?.general ?? 101) - (b.averages.terms[current]?.general ?? 101));
  const classAvg = (() => {
    const values = report.students.map((r) => r.averages.terms[current]?.general).filter((v) => v != null);
    return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
  })();
  const below = report.students.filter((r) => (r.averages.terms[current]?.general ?? 100) < PASS_PCT).length;

  return (
    <main>
      <div className="tabs-term" role="group" aria-label="Période">
        {terms.map((t) => (
          <button key={t} type="button" aria-pressed={t === current} onClick={() => setTerm(t)}>
            {TERMS.find((x) => x.code === t)?.label ?? t}
          </button>
        ))}
      </div>
      <div className="stats">
        <div className="stat">
          <b>
            <Avg value={classAvg} />
          </b>
          <span>Moyenne de la classe</span>
        </div>
        <div className="stat">
          <b style={{ color: below ? 'var(--red)' : 'var(--green)' }}>{below}</b>
          <span>Sous 50 %</span>
        </div>
        <div className="stat">
          <b style={{ color: report.struggling.length ? 'var(--red)' : 'var(--green)' }}>{report.struggling.length}</b>
          <span>En difficulté</span>
        </div>
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="tabs-term" role="group" aria-label="Filtre">
        <button type="button" aria-pressed={onlyStruggling} onClick={() => setOnlyStruggling(true)}>
          En difficulté ({report.struggling.length})
        </button>
        <button type="button" aria-pressed={!onlyStruggling} onClick={() => setOnlyStruggling(false)}>
          Tous les élèves ({report.students.length})
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="card center">
          <b>Aucun élève en difficulté 👍</b>
          <p className="muted">Une alerte apparaît dès qu’un élève passe sous 50 %, perd 10 points ou enchaîne deux échecs dans une matière.</p>
        </div>
      ) : (
        <div className="list">
          {rows.map((r) => {
            const t = r.averages.terms[current];
            const subjectEntries = t ? Object.entries(t.subjects).sort((a, b) => (subjectName.get(a[0]) ?? '').localeCompare(subjectName.get(b[0]) ?? '', 'fr')) : [];
            return (
              <div className={`item col ${r.signals.length ? 'flag' : ''}`} key={r.student.id}>
                <div className="line">
                  <div className="who">
                    <b>{studentName(r.student)}</b>
                    <small>
                      {t ? `${t.count} cote(s) au ${current}` : `Aucune cote au ${current}`} · année : <Avg value={r.averages.year.general} />
                    </small>
                  </div>
                  <Avg value={t?.general} className="avg-big" />
                </div>
                {subjectEntries.length > 0 && (
                  <div className="chips">
                    {subjectEntries.map(([id, v]) => (
                      <span key={id} className={`chip ${v < PASS_PCT ? 'low' : ''}`}>
                        {subjectName.get(id) ?? 'Matière'} {Math.round(v)} %
                      </span>
                    ))}
                  </div>
                )}
                {r.signals.map((s) => (
                  <div key={s.key} className="reason">
                    <div className="chips">
                      {s.signals.map((x) => (
                        <span key={x} className={`chip sig ${x}`}>
                          {SIGNAL_LABELS[x]}
                        </span>
                      ))}
                    </div>
                    <div style={{ marginTop: 3 }}>{s.summary}</div>
                    {s.server ? (
                      <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {s.server.smsStatus === 'SENT' && <span className="followed">✉ Tuteur prévenu par SMS</span>}
                        {s.server.status === 'ACKNOWLEDGED' ? (
                          <span className="followed">
                            ✓ Suivi{s.server.acknowledgedBy ? ` par ${s.server.acknowledgedBy}` : ''}
                            {s.server.note ? ` — ${s.server.note}` : ''}
                          </span>
                        ) : (
                          <button className="btn btn-ghost btn-sm" disabled={!online || busy === s.server.id} onClick={() => acknowledge(s.server, r.student)}>
                            {busy === s.server.id ? 'Envoi…' : '✓ Élève pris en charge'}
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                        Alerte calculée sur le téléphone : elle sera transmise à la direction et au tuteur à l’envoi des cotes.
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
      <p className="muted" style={{ textAlign: 'center', marginTop: 14 }}>
        Moyenne = total des points obtenus ÷ total des points possibles. Seuil de réussite : 50 %.
        {session.user.role !== 'TEACHER' ? '' : ' La direction voit aussi ces alertes.'}
      </p>
    </main>
  );
}

/* ---------------------------------------------------------------------- App */

export default function TeacherApp() {
  const [session, setSession] = useState(readSession);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [bootstrap, setBootstrap] = useState(null);
  const [ready, setReady] = useState(false);
  const [screen, setScreen] = useState({ name: 'home' });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const [reports, setReports] = useState(new Map());
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const engine = useMemo(() => new SyncEngine({ getToken: () => sessionRef.current?.token, onUnauthorized: () => setNeedsLogin(true) }), []);
  const [sync, setSync] = useState(engine.state);
  useEffect(() => engine.subscribe(setSync), [engine]);

  // Moyennes et élèves en difficulté, recalculés à chaque saisie et après chaque envoi (hors ligne compris).
  useEffect(() => {
    if (!bootstrap?.classes?.length) {
      setReports(new Map());
      return undefined;
    }
    let alive = true;
    Promise.all(bootstrap.classes.map(async (c) => [c.id, classReport(c, await classGrades(c.id), bootstrap.subjects, (bootstrap.alerts ?? []).filter((a) => a.classId === c.id))])).then(
      (entries) => alive && setReports(new Map(entries)),
    );
    return () => {
      alive = false;
    };
  }, [bootstrap, sync.pending, sync.syncing, screen.name]);

  // Une alerte a été ouverte, modifiée ou fermée par le serveur : on recharge la liste des alertes.
  useEffect(() => {
    const token = sessionRef.current?.token;
    if (!sync.alertsVersion || !token) return;
    refreshAlerts(token)
      .then((b) => b && setBootstrap(b))
      .catch(() => {});
  }, [sync.alertsVersion]);

  const refresh = useCallback(async () => {
    const token = sessionRef.current?.token;
    if (!token) return;
    setRefreshing(true);
    setRefreshError('');
    try {
      setBootstrap(await refreshBootstrap(token));
    } catch (err) {
      if (err.status === 401) setNeedsLogin(true);
      else setRefreshError(err.status === 0 ? 'Pas de réseau : les listes enregistrées sur le téléphone restent utilisables.' : err.message);
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Démarrage : listes locales immédiatement (fonctionne hors ligne), puis mise à jour si le réseau le permet.
  useEffect(() => {
    if (!session) {
      setReady(true);
      return undefined;
    }
    let alive = true;
    loadBootstrap()
      .then((b) => alive && setBootstrap(b ?? null))
      .finally(() => alive && setReady(true));
    engine.start();
    if (navigator.onLine) {
      if (isExpired(session.token)) setNeedsLogin(true);
      else refresh();
    }
    return () => {
      alive = false;
      engine.stop();
    };
  }, [session?.user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Jeton expiré et réseau revenu : on demande la reconnexion sans rien effacer.
  useEffect(() => {
    if (session && sync.online && isExpired(session.token)) setNeedsLogin(true);
  }, [session, sync.online]);

  // Bouton « retour » d'Android et geste de retour : revient à l'accueil.
  useEffect(() => {
    const onPop = () => setScreen({ name: 'home' });
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const open = (name, classId) => {
    window.history.pushState({ screen: name }, '');
    setScreen({ name, classId });
  };
  const back = () => {
    if (window.history.state?.screen) window.history.back();
    else setScreen({ name: 'home' });
  };

  async function doLogin(phone, password) {
    const s = await apiLogin(phone, password);
    setSession(s);
    setNeedsLogin(false);
    setRefreshError('');
    engine.resume();
    setBootstrap((await loadBootstrap()) ?? null);
    try {
      setBootstrap(await refreshBootstrap(s.token));
    } catch (err) {
      setRefreshError(err.message);
    }
  }

  async function logout() {
    const pending = engine.state.pending;
    const msg = pending
      ? `${pending} saisie(s) ne sont pas encore envoyées et seront perdues. Se déconnecter quand même ?`
      : 'Se déconnecter ? Les listes seront effacées de ce téléphone.';
    if (!window.confirm(msg)) return;
    engine.stop();
    await clearLocalData();
    writeSession(null);
    setSession(null);
    setBootstrap(null);
    setScreen({ name: 'home' });
  }

  let content;
  if (!session || needsLogin) {
    content = <LoginScreen onLogin={doLogin} expiredUser={needsLogin ? session?.user : null} />;
  } else if (!ready) {
    content = <div className="center muted">Chargement…</div>;
  } else {
    const cls = bootstrap?.classes.find((c) => c.id === screen.classId);
    const syncTap = () => (sync.online ? engine.run() : window.alert('Pas de réseau : vos saisies sont enregistrées sur le téléphone et partiront automatiquement au retour du réseau.'));
    if (screen.name !== 'home' && cls) {
      const title = screen.name === 'attendance' ? `Appel — ${cls.name}` : screen.name === 'results' ? `Moyennes — ${cls.name}` : `Cotes — ${cls.name}`;
      content = (
        <>
          <TopBar title={title} subtitle={`${cls.students.length} élèves`} onBack={back} sync={sync} onSyncTap={syncTap} />
          {screen.name === 'attendance' ? (
            <AttendanceScreen cls={cls} engine={engine} sync={sync} />
          ) : screen.name === 'results' ? (
            <ResultsScreen
              cls={cls}
              subjects={bootstrap.subjects}
              report={reports.get(cls.id) ?? classReport(cls, [], bootstrap.subjects)}
              session={session}
              online={sync.online}
              onAcknowledged={async (alertId, note) => {
                const b = await acknowledgeAlert(sessionRef.current.token, alertId, note);
                if (b) setBootstrap(b);
              }}
            />
          ) : (
            <GradesScreen cls={cls} subjects={bootstrap.subjects} engine={engine} sync={sync} />
          )}
        </>
      );
    } else {
      content = (
        <>
          <TopBar title="Espace Enseignant" subtitle={bootstrap?.school?.name ?? session.school?.name} sync={sync} onSyncTap={syncTap} />
          <Home
            session={session}
            bootstrap={bootstrap}
            sync={sync}
            engine={engine}
            refreshing={refreshing}
            refreshError={refreshError}
            onRefresh={refresh}
            onOpen={open}
            onLogout={logout}
            reports={reports}
          />
        </>
      );
    }
  }

  return (
    <div className="app">
      <style>{CSS + PASSWORD_CSS}</style>
      {content}
    </div>
  );
}
