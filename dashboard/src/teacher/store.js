import { apiFetch, ApiError, tokenExpiry } from '../lib.js';

/* =============================================================================
   Espace Enseignant (PWA) — stockage local et synchronisation hors ligne
   - IndexedDB : listes (classes, élèves, matières), présences et cotes locales
   - Chaque saisie est enregistrée d'abord sur l'appareil (statut « pending »),
     puis envoyée par lots à l'API dès que le réseau est disponible
   - Même contrat que l'application Android : POST /api/attendance/sync et
     /api/grades/sync, « dernière écriture gagnante » selon clientUpdatedAt
   - Échec réseau / 429 / 5xx : nouvel essai avec délai exponentiel (5 s → 15 min)
   - 401 : envoi suspendu, données conservées jusqu'à la reconnexion
   ============================================================================= */

export const MAX_PAST_DAYS = 60;
export const EVALUATIONS = ['Interrogation 1', 'Interrogation 2', 'Interrogation 3', 'Devoir', 'Examen'];
export const TERMS = [
  { code: 'T1', label: '1er trimestre' },
  { code: 'T2', label: '2e trimestre' },
  { code: 'T3', label: '3e trimestre' },
];

const DB_NAME = 'schoolap-enseignant';
const DB_VERSION = 1;
const SESSION_KEY = 'schoolap.enseignant.session';
const BATCH_SIZE = 200;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const PERIODIC_MS = 60_000;

/* ------------------------------------------------------------ IndexedDB */

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('attendance')) db.createObjectStore('attendance', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('grades')) db.createObjectStore('grades', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Base locale bloquée : fermez les autres onglets de l’Espace Enseignant.'));
    });
  }
  return dbPromise;
}

async function tx(storeName, mode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    Promise.resolve(work(store))
      .then((r) => {
        result = r;
      })
      .catch(reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction annulée'));
  });
}

const req2p = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const kvGet = (key) => tx('kv', 'readonly', (s) => req2p(s.get(key)));
const kvSet = (key, value) => tx('kv', 'readwrite', (s) => req2p(s.put(value, key)));
const getAll = (storeName) => tx(storeName, 'readonly', (s) => req2p(s.getAll()));
const putMany = (storeName, rows) =>
  tx(storeName, 'readwrite', (s) => {
    rows.forEach((r) => s.put(r));
  });
const getOne = (storeName, key) => tx(storeName, 'readonly', (s) => req2p(s.get(key)));

export async function clearLocalData() {
  for (const name of ['kv', 'attendance', 'grades']) {
    await tx(name, 'readwrite', (s) => req2p(s.clear()));
  }
}

/* -------------------------------------------------------------- Outils */

export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Date du jour à Goma / Lubumbashi (UTC+2), au format AAAA-MM-JJ. */
export function todayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lubumbashi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function shiftIso(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function studentName(s) {
  return [s.lastName?.toUpperCase(), s.middleName?.toUpperCase(), s.firstName].filter(Boolean).join(' ');
}

/** Accepte « 12 », « 12,5 » ou « 12.5 » (clavier décimal iPhone en français). */
export function parseScore(text) {
  const t = String(text ?? '').trim().replace(',', '.');
  if (!t || !/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Number(t);
}

export const formatScore = (n) => (Number.isInteger(n) ? String(n) : String(n).replace('.', ','));

const attendanceKey = (studentId, date) => `${studentId}|${date}`;
const gradeKey = (studentId, subjectId, term, evaluation) => `${studentId}|${subjectId}|${term}|${evaluation}`;

/* ------------------------------------------------------------- Session */

export function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeSession(session) {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* stockage indisponible : la session reste en mémoire */
  }
}

export const isExpired = (token) => {
  const exp = tokenExpiry(token);
  return exp === null || exp <= Date.now();
};

/** Connexion ; si un autre enseignant utilisait l'appareil, ses données locales sont effacées. */
export async function login(phone, password) {
  const data = await apiFetch('/api/auth/login', { method: 'POST', body: { phone, password } });
  if (!data.user.permissions?.includes('TAKE_ATTENDANCE')) {
    throw new ApiError(403, 'FORBIDDEN', 'Ce compte n’a pas accès à l’appel. L’Espace Enseignant est réservé aux enseignants et à l’équipe pédagogique.');
  }
  const previous = await kvGet('ownerId');
  if (previous && previous !== data.user.id) await clearLocalData();
  await kvSet('ownerId', data.user.id);
  const session = { token: data.token, user: data.user, school: data.school };
  writeSession(session);
  return session;
}

/* ----------------------------------------------------- Données de référence */

export const loadBootstrap = () => kvGet('bootstrap');

/** Recharge classes, élèves, matières, appel du jour et cotes depuis le serveur. */
export async function refreshBootstrap(token) {
  const data = await apiFetch('/api/teacher/bootstrap', { token });
  const bootstrap = {
    fetchedAt: new Date().toISOString(),
    serverDate: data.serverDate,
    school: data.school,
    classes: data.classes,
    subjects: data.subjects,
  };
  await kvSet('bootstrap', bootstrap);

  // Fusion : une saisie locale non envoyée (ou refusée) n'est jamais écrasée par le serveur.
  const studentClass = new Map(data.classes.flatMap((c) => c.students.map((s) => [s.id, c.id])));
  const localAtt = new Map((await getAll('attendance')).map((r) => [r.key, r]));
  const attRows = [];
  for (const a of data.attendance) {
    const key = attendanceKey(a.studentId, a.date);
    const local = localAtt.get(key);
    if (local && local.sync !== 'synced') continue;
    attRows.push({ key, id: a.id, studentId: a.studentId, classId: a.classId ?? studentClass.get(a.studentId), date: a.date, status: a.status, clientUpdatedAt: a.clientUpdatedAt, sync: 'synced', smsStatus: local?.smsStatus ?? null });
  }
  await putMany('attendance', attRows);

  const localGrades = new Map((await getAll('grades')).map((r) => [r.key, r]));
  const gradeRows = [];
  for (const g of data.grades) {
    const key = gradeKey(g.studentId, g.subjectId, g.term, g.evaluation);
    const local = localGrades.get(key);
    if (local && local.sync !== 'synced') continue;
    gradeRows.push({ key, id: g.id, studentId: g.studentId, classId: studentClass.get(g.studentId), subjectId: g.subjectId, term: g.term, evaluation: g.evaluation, maxScore: g.maxScore, score: g.score, clientUpdatedAt: g.clientUpdatedAt, sync: 'synced' });
  }
  await putMany('grades', gradeRows);
  return bootstrap;
}

/* --------------------------------------------------------- Saisies locales */

export async function attendanceFor(classId, date) {
  const rows = await getAll('attendance');
  return new Map(rows.filter((r) => r.classId === classId && r.date === date).map((r) => [r.studentId, r]));
}

export async function saveAttendance({ studentId, classId, date, status }) {
  const key = attendanceKey(studentId, date);
  const existing = await getOne('attendance', key);
  const row = {
    key,
    id: existing?.id ?? uuid(),
    studentId,
    classId,
    date,
    status,
    clientUpdatedAt: new Date().toISOString(),
    sync: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    error: null,
    smsStatus: existing?.smsStatus ?? null,
  };
  await putMany('attendance', [row]);
  return row;
}

export async function gradesFor({ classId, subjectId, term, evaluation }) {
  const rows = await getAll('grades');
  return new Map(rows.filter((r) => r.classId === classId && r.subjectId === subjectId && r.term === term && r.evaluation === evaluation).map((r) => [r.studentId, r]));
}

export async function saveGrade({ studentId, classId, subjectId, term, evaluation, maxScore, score }) {
  const key = gradeKey(studentId, subjectId, term, evaluation);
  const existing = await getOne('grades', key);
  const row = {
    key,
    id: existing?.id ?? uuid(),
    studentId,
    classId,
    subjectId,
    term,
    evaluation,
    maxScore,
    score,
    clientUpdatedAt: new Date().toISOString(),
    sync: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    error: null,
  };
  await putMany('grades', [row]);
  return row;
}

/* ------------------------------------------------------- Synchronisation */

const ENTITIES = {
  attendance: {
    path: '/api/attendance/sync',
    payload: (r) => ({ id: r.id, studentId: r.studentId, date: r.date, status: r.status, clientUpdatedAt: r.clientUpdatedAt }),
  },
  grades: {
    path: '/api/grades/sync',
    payload: (r) => ({ id: r.id, studentId: r.studentId, subjectId: r.subjectId, term: r.term, evaluation: r.evaluation, maxScore: r.maxScore, score: r.score, clientUpdatedAt: r.clientUpdatedAt }),
  },
};

const errorsText = (errors) => (Array.isArray(errors) ? errors.map((e) => e.message).join(' ') : 'Refusé par le serveur.');
const backoff = (attempts) => Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 3 ** attempts) * (0.8 + Math.random() * 0.4);

export class SyncEngine {
  constructor({ getToken, onUnauthorized }) {
    this.getToken = getToken;
    this.onUnauthorized = onUnauthorized;
    this.listeners = new Set();
    this.state = { online: navigator.onLine, syncing: false, pending: 0, rejected: 0, lastSyncAt: null, lastError: null, paused: false, smsSent: 0 };
    this.timer = null;
    this.debounce = null;
    this.running = null;
    this.handleOnline = () => {
      this.set({ online: true });
      this.trigger(300);
    };
    this.handleOffline = () => this.set({ online: false });
    this.handleVisible = () => document.visibilityState === 'visible' && this.trigger(300);
  }

  start() {
    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);
    document.addEventListener('visibilitychange', this.handleVisible);
    this.interval = setInterval(() => this.trigger(0), PERIODIC_MS);
    kvGet('lastSyncAt').then((v) => v && this.set({ lastSyncAt: v }));
    this.refreshCounts().then(() => this.trigger(500));
  }

  stop() {
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
    document.removeEventListener('visibilitychange', this.handleVisible);
    clearInterval(this.interval);
    clearTimeout(this.timer);
    clearTimeout(this.debounce);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn(this.state));
  }

  resume() {
    this.set({ paused: false, lastError: null });
    this.trigger(0);
  }

  /** À appeler après chaque saisie : regroupe les envois rapprochés. */
  notifyLocalChange() {
    this.refreshCounts();
    this.trigger(800);
  }

  trigger(delay = 0) {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.run(), delay);
  }

  async refreshCounts() {
    const rows = [...(await getAll('attendance')), ...(await getAll('grades'))];
    this.set({ pending: rows.filter((r) => r.sync === 'pending').length, rejected: rows.filter((r) => r.sync === 'rejected').length });
  }

  run() {
    if (this.running) return this.running;
    this.running = this.runOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async runOnce() {
    const token = this.getToken();
    if (!token || this.state.paused) return;
    if (!navigator.onLine) {
      this.set({ online: false });
      await this.refreshCounts();
      return;
    }
    this.set({ syncing: true, online: true });
    let failed = false;
    try {
      for (const entity of Object.keys(ENTITIES)) {
        for (;;) {
          const now = Date.now();
          const due = (await getAll(entity)).filter((r) => r.sync === 'pending' && (r.nextAttemptAt ?? 0) <= now).slice(0, BATCH_SIZE);
          if (due.length === 0) break;
          const ok = await this.sendBatch(entity, due, token);
          if (!ok) {
            failed = true;
            break;
          }
        }
        if (failed) break;
      }
      if (!failed) {
        const at = new Date().toISOString();
        await kvSet('lastSyncAt', at);
        this.set({ lastSyncAt: at, lastError: null });
      }
    } finally {
      this.set({ syncing: false });
      await this.refreshCounts();
      this.scheduleRetry();
    }
  }

  async scheduleRetry() {
    clearTimeout(this.timer);
    const rows = [...(await getAll('attendance')), ...(await getAll('grades'))].filter((r) => r.sync === 'pending');
    if (rows.length === 0) return;
    const next = Math.min(...rows.map((r) => r.nextAttemptAt ?? 0));
    this.timer = setTimeout(() => this.run(), Math.max(1_000, next - Date.now()));
  }

  /** Après un envoi, n'acquitte que si la saisie n'a pas été modifiée entre-temps. */
  async settle(entity, sent, patchFor) {
    const current = new Map((await getAll(entity)).map((r) => [r.key, r]));
    const rows = [];
    sent.forEach((r, i) => {
      const now = current.get(r.key);
      if (!now || now.clientUpdatedAt !== r.clientUpdatedAt) return;
      const patch = patchFor(i);
      if (patch) rows.push({ ...now, ...patch });
    });
    await putMany(entity, rows);
  }

  async sendBatch(entity, items, token) {
    const { path, payload } = ENTITIES[entity];
    try {
      const res = await apiFetch(path, { token, method: 'POST', body: { records: items.map(payload) } });
      if (entity === 'attendance') this.set({ smsSent: this.state.smsSent + (res.summary?.smsSent ?? 0) });
      const byIndex = new Map((res.results ?? []).map((r) => [r.index, r]));
      await this.settle(entity, items, (i) => {
        const r = byIndex.get(i);
        if (!r) return { attempts: (items[i].attempts ?? 0) + 1, nextAttemptAt: Date.now() + backoff(items[i].attempts ?? 0), error: 'Réponse incomplète du serveur' };
        if (r.result === 'rejected') return { sync: 'rejected', error: errorsText(r.errors) };
        return { sync: 'synced', error: null, ...(r.sms ? { smsStatus: r.sms } : {}) };
      });
      return true;
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.status === 401) {
        this.set({ paused: true, lastError: 'Session expirée : reconnectez-vous pour envoyer vos saisies (elles restent sur l’appareil).' });
        this.onUnauthorized?.();
        return false;
      }
      if (err.status === 0 || err.status === 408 || err.status === 429 || err.status >= 500) {
        this.set({ lastError: err.message, online: err.status === 0 ? navigator.onLine : true });
        await this.settle(entity, items, (i) => ({ attempts: (items[i].attempts ?? 0) + 1, nextAttemptAt: Date.now() + backoff(items[i].attempts ?? 0), error: err.message }));
        return false;
      }
      // 400 global : aucun enregistrement valide, détail par index dans error.details
      const details = new Map((Array.isArray(err.details) ? err.details : []).map((d) => [d.index, d]));
      await this.settle(entity, items, (i) => ({ sync: 'rejected', error: details.has(i) ? errorsText(details.get(i).errors) : err.message }));
      this.set({ lastError: err.message });
      return true;
    }
  }
}
