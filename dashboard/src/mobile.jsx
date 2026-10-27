import { useEffect, useRef, useState } from 'react';
import { ROLE_LABELS, initials } from './lib.js';

/* =============================================================================
   Affichage téléphone du tableau de bord
   - Barre de navigation en bas de l'écran (icônes toujours visibles)
   - Menu du profil (nom, rôle, bureau, installation, déconnexion)
   - Installation sur l'écran d'accueil (Android : bouton ; iPhone : Partager)
   - Détection du réseau (bandeau « Hors ligne »)
   ============================================================================= */

export const MOBILE_QUERY = '(max-width: 720px)';

/** Vrai sur un écran de téléphone ; suit la rotation et le redimensionnement. */
export function useIsMobile() {
  const get = () => typeof window !== 'undefined' && window.matchMedia?.(MOBILE_QUERY).matches === true;
  const [mobile, setMobile] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.(MOBILE_QUERY);
    if (!mq) return undefined;
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return mobile;
}

/** État du réseau du téléphone. */
export function useOnline() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

export const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches === true || window.navigator.standalone === true;
export const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Proposition d'installation d'Android/Chrome, conservée jusqu'à ce que l'utilisateur la demande. */
export function useInstallPrompt() {
  const [deferred, setDeferred] = useState(null);
  useEffect(() => {
    const onPrompt = (e) => {
      e.preventDefault();
      setDeferred(e);
    };
    const onInstalled = () => setDeferred(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  return [deferred, () => setDeferred(null)];
}

/* ------------------------------------------------------------------ Icônes */

const ICON_PATHS = {
  dashboard: (
    <>
      <path d="M3 13h8V3H3z" />
      <path d="M13 21h8V11h-8z" />
      <path d="M3 21h8v-6H3z" />
      <path d="M13 9h8V3h-8z" />
    </>
  ),
  students: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5" />
      <circle cx="17" cy="9" r="2.6" />
      <path d="M16.5 14.6c2.6.1 4.4 1.7 5 4.4" />
    </>
  ),
  classes: (
    <>
      <path d="M3 21V8l9-5 9 5v13" />
      <path d="M9 21v-6h6v6" />
      <path d="M3 21h18" />
      <path d="M9 10h.01M15 10h.01" />
    </>
  ),
  fees: (
    <>
      <rect x="2.5" y="6" width="19" height="13" rx="2.5" />
      <path d="M2.5 10.5h19" />
      <path d="M6.5 15h4" />
    </>
  ),
  install: (
    <>
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 21h14" />
    </>
  ),
  logout: (
    <>
      <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
      <path d="M10 17l5-5-5-5" />
      <path d="M15 12H3" />
    </>
  ),
  share: (
    <>
      <path d="M12 3v12" />
      <path d="M7 8l5-5 5 5" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </>
  ),
};

export function Icon({ name, size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICON_PATHS[name]}
    </svg>
  );
}

/* --------------------------------------------------------- Barre du bas */

/** Navigation principale sur téléphone : 4 onglets toujours visibles, au pouce. */
export function BottomNav({ tabs, current, onSelect }) {
  return (
    <nav className="bottom-nav" aria-label="Navigation principale">
      {tabs.map((t) => (
        <button key={t.id} type="button" className="bn-item" aria-current={current === t.id ? 'page' : undefined} onClick={() => onSelect(t.id)}>
          <Icon name={t.icon} />
          <span>{t.short}</span>
        </button>
      ))}
    </nav>
  );
}

/* ----------------------------------------------------- Installation */

/** Fenêtre d'aide à l'installation sur iPhone (Safari → Partager → Sur l'écran d'accueil). */
export function IosInstallSheet({ onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" role="dialog" aria-modal="true" aria-label="Installer l’application" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal sheet">
        <div className="modal-head">
          <h3>Installer sur l’iPhone</h3>
          <button className="modal-close" onClick={onClose} aria-label="Fermer">
            ×
          </button>
        </div>
        <div className="modal-body">
          <ol className="install-steps">
            <li>
              Ouvrez ce tableau de bord dans <b>Safari</b>.
            </li>
            <li>
              Touchez{' '}
              <span className="share-ico">
                <Icon name="share" size={16} />
              </span>{' '}
              <b>Partager</b> en bas de l’écran.
            </li>
            <li>
              Choisissez <b>« Sur l’écran d’accueil »</b>, puis <b>Ajouter</b>.
            </li>
          </ol>
          <p className="muted" style={{ margin: '12px 0 0' }}>
            L’icône « Direction » s’ouvrira en plein écran. Les derniers chiffres consultés restent lisibles sans réseau.
          </p>
        </div>
        <div className="modal-foot">
          <button className="btn btn-primary btn-block" onClick={onClose}>
            J’ai compris
          </button>
        </div>
      </div>
    </div>
  );
}

const INSTALL_HINT_KEY = 'erp.directeur.installHint';

/** Carte discrète, affichée une seule fois sur téléphone, proposant d'installer l'application. */
export function InstallCard({ deferred, onInstall, onIosHelp }) {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(INSTALL_HINT_KEY) === 'masque';
    } catch {
      return false;
    }
  });
  if (hidden || isStandalone() || (!deferred && !isIOS())) return null;
  const close = () => {
    try {
      localStorage.setItem(INSTALL_HINT_KEY, 'masque');
    } catch {
      /* stockage indisponible : la carte réapparaîtra simplement */
    }
    setHidden(true);
  };
  return (
    <div className="install-card" role="note">
      <span className="install-ico">
        <Icon name="install" />
      </span>
      <div className="install-text">
        <b>Installer le tableau de bord</b>
        <span>Une icône sur l’écran d’accueil, ouverture en plein écran, chiffres lisibles sans réseau.</span>
      </div>
      <div className="install-actions">
        <button
          className="btn btn-primary btn-sm"
          onClick={async () => {
            if (deferred) await onInstall();
            else onIosHelp();
            close();
          }}
        >
          Installer
        </button>
        <button className="install-x" onClick={close} aria-label="Masquer la proposition d’installation">
          ×
        </button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- Menu du profil */

/** Avatar cliquable : identité, bureau, installation et déconnexion (remplace la barre chargée). */
export function UserMenu({ user, onLogout, canInstall, onInstall }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const role = user.roleLabel ?? ROLE_LABELS[user.role];
  return (
    <div className="user-menu" ref={ref}>
      <button type="button" className="user-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="avatar" aria-hidden="true">
          {initials(user.fullName)}
        </span>
        <span className="user-btn-text">
          <span className="user-name">{user.fullName}</span>
          <span className="role-tag">{role}</span>
        </span>
        <span className="sr-only">Ouvrir le menu du profil</span>
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          <div className="menu-id">
            <b>{user.fullName}</b>
            <span>
              {role}
              {user.office ? ` · ${user.office.name}` : ''}
            </span>
          </div>
          {canInstall && (
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                onInstall();
              }}
            >
              <Icon name="install" size={18} /> Installer l’application
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="menu-item danger"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            <Icon name="logout" size={18} /> Se déconnecter
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Styles */

export const MOBILE_CSS = `
/* --- Encoche de l'iPhone (application installée en plein écran) --- */
.topbar{padding-top:env(safe-area-inset-top)}

/* --- Menu du profil --- */
.user-menu{position:relative}
.user-btn{display:flex;align-items:center;gap:10px;background:transparent;border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:3px 14px 3px 3px;color:#fff;min-height:44px;text-align:left}
.user-btn:hover{background:rgba(255,255,255,.08)}
.user-btn-text{display:flex;flex-direction:column;line-height:1.2;font-size:13px;font-weight:600;max-width:220px}
.user-btn-text .user-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.user-btn-text .role-tag{font-weight:400}
.menu-pop{position:absolute;right:0;top:calc(100% + 8px);background:#fff;color:var(--grey-900);border-radius:14px;box-shadow:0 18px 50px rgba(11,37,69,.28);min-width:260px;max-width:calc(100vw - 24px);padding:6px;z-index:40}
.menu-id{padding:12px 12px 10px;border-bottom:1px solid var(--grey-200);margin-bottom:4px;display:flex;flex-direction:column;gap:2px}
.menu-id span{font-size:13px;color:var(--grey-500)}
.menu-item{display:flex;align-items:center;gap:10px;width:100%;min-height:46px;border:0;background:transparent;border-radius:10px;padding:0 12px;font-weight:600;color:var(--navy-900);text-align:left}
.menu-item:hover{background:var(--grey-100)}
.menu-item.danger{color:var(--red-600)}

/* --- Barre du bas (téléphone) --- */
.bottom-nav{display:none}
.bn-spacer{display:none}
.sm-only{display:none}
.bn-item{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;border:0;background:transparent;color:var(--grey-500);font-size:11.5px;font-weight:600;min-height:58px;padding:6px 2px;position:relative}
.bn-item[aria-current=page]{color:var(--navy-900)}
.bn-item[aria-current=page]::before{content:"";position:absolute;top:0;left:22%;right:22%;height:3px;border-radius:0 0 3px 3px;background:var(--navy-700)}
.bn-item[aria-current=page] svg{stroke-width:2.4}

/* --- Bandeaux --- */
.offline-bar{background:#3B2A06;color:#FDE7B0;font-size:13px;font-weight:600;text-align:center;padding:7px 12px;line-height:1.35}
.pending-alert{display:flex;gap:10px;align-items:flex-start}
.pending-alert b{white-space:nowrap}
.day-tools{display:flex;gap:8px;align-items:center}
.day-tools input[type=date]{height:44px;border:1px solid var(--grey-300);border-radius:10px;padding:0 10px;background:#fff;color:var(--grey-900);min-width:0}
.more-row{padding:10px 16px 14px;text-align:center}

/* --- Installation --- */
.install-card{display:flex;align-items:center;gap:12px;background:#fff;border:1px solid #C8D7EE;border-radius:14px;padding:12px 12px 12px 14px;margin-bottom:16px;box-shadow:var(--shadow)}
.install-ico{width:40px;height:40px;border-radius:10px;background:var(--navy-100);color:var(--navy-700);display:grid;place-items:center;flex:none}
.install-text{display:flex;flex-direction:column;gap:2px;font-size:13px;color:var(--grey-500);min-width:0;flex:1}
.install-text b{color:var(--navy-900);font-size:14px}
.install-actions{display:flex;align-items:center;gap:4px}
.install-x{width:36px;height:36px;border:0;background:transparent;font-size:22px;color:var(--grey-500);border-radius:8px}
.install-steps{margin:0;padding-left:22px;display:grid;gap:12px;line-height:1.5}
.share-ico{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:7px;background:var(--navy-100);color:var(--navy-700);vertical-align:middle}

/* --- Téléphone --- */
@media (max-width:720px){
  .bn-spacer{display:block;height:calc(70px + env(safe-area-inset-bottom))}
  .bottom-nav{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:30;background:#fff;border-top:1px solid var(--grey-200);box-shadow:0 -4px 18px rgba(15,23,42,.08);padding-bottom:env(safe-area-inset-bottom)}
  .tabs{display:none}
  .lg-only{display:none}
  .sm-only{display:inline}
  table.compact .link{text-decoration:none;color:var(--grey-900);min-height:0;font-weight:700}
  footer{display:none}

  /* En-tête compact sur une ligne */
  .topbar-inner{flex-wrap:nowrap;padding:8px 12px;gap:10px}
  .brand-logo{width:36px;height:36px}
  .brand-name{font-size:15px}
  .brand-sub{font-size:11.5px}
  .topbar-actions{width:auto;margin-left:auto}
  .user-btn{padding:3px;border-color:transparent}
  .user-btn-text{display:none}
  .avatar{width:38px;height:38px}

  /* Contenu */
  .page{padding:14px 12px}
  .page-head{margin-bottom:14px;align-items:stretch}
  .page-head h1{font-size:21px}
  .page-head>div:first-child{min-width:0}
  .day-tools{width:100%}
  .day-tools input[type=date]{flex:1}
  .day-tools .btn{flex:none}

  /* Indicateurs : 2 tuiles par ligne */
  .kpis,.kpis.fees-kpis{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:16px}
  .kpi{padding:12px;min-height:0;gap:4px;border-top-width:3px}
  .kpi-label{font-size:11px;letter-spacing:.3px}
  .kpi-value{font-size:24px}
  .kpi-foot{font-size:11.5px;line-height:1.35}
  .grid-2{gap:14px;margin-bottom:14px}
  .card-head{padding:12px 14px}
  .card-body{padding:12px 14px}

  /* Champs : 16 px minimum, sinon l'iPhone zoome à chaque saisie */
  input,select,textarea,.search,.field input,.field select,.toolbar select,.toolbar input{font-size:16px}
  .search{height:44px}
  .toolbar select,.toolbar input,.inline-form input{height:44px}
  .card-tools.toolbar{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .card-tools.toolbar .search{grid-column:1 / -1;order:-1}

  /* Zones tactiles d'au moins 44 px */
  .btn{min-height:44px;height:auto;white-space:normal;text-align:center;line-height:1.25;padding-top:8px;padding-bottom:8px}
  .btn-sm{min-height:42px;font-size:14px}
  .link{min-height:32px;text-align:left}
  .page-head .toolbar{display:grid;grid-template-columns:1fr 1fr;gap:8px;width:100%}
  .page-head .toolbar>*:only-child{grid-column:1 / -1}

  /* Listes compactes : une ligne par élément, le reste dans la fiche */
  table.compact tbody tr{grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;padding:12px 14px;align-items:center}
  table.compact tbody td::before{display:none}
  table.compact tbody td.c-main{grid-column:1;grid-row:1}
  table.compact tbody td.c-sub{grid-column:1;grid-row:2;font-size:13px;color:var(--grey-500)}
  table.compact tbody td.c-end{grid-column:2;grid-row:1 / span 2;text-align:right;align-self:center}
  table.compact .hide-sm{display:none!important}
  tr.tap{cursor:pointer;-webkit-tap-highlight-color:rgba(29,78,137,.12)}
  tr.tap:active{background:var(--navy-100)}
  tr.tap td.c-end::after{content:"›";margin-left:8px;color:var(--grey-300);font-size:20px;vertical-align:-2px}

  /* Formulaires et fenêtres en plein écran, bouton d'action toujours visible */
  .backdrop{padding:0;place-items:end stretch}
  .modal,.modal.wide{max-width:none;width:100%;height:100%;max-height:100%;border-radius:0;display:flex;flex-direction:column}
  .modal>form{display:flex;flex-direction:column;flex:1;min-height:0}
  .modal-head{padding:12px 14px;padding-top:calc(12px + env(safe-area-inset-top));flex:none}
  .modal-close{width:44px;height:44px;font-size:28px}
  .modal-body,.modal-body.scroll{flex:1;min-height:0;max-height:none;overflow:auto;padding:16px 14px}
  .modal-foot{flex:none;padding:10px 14px calc(10px + env(safe-area-inset-bottom));border-top:1px solid var(--grey-200);background:#fff;display:flex;gap:10px}
  .modal-foot .btn{flex:1}
  .modal.sheet{height:auto;max-height:92%;border-radius:18px 18px 0 0}

  /* Notifications au-dessus de la barre du bas */
  .toasts{left:12px;right:12px;bottom:calc(74px + env(safe-area-inset-bottom));max-width:none}
  .stat-row{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
  .stat b{font-size:17px}
  .offices{grid-template-columns:1fr;padding:12px}
}
@media (max-width:720px){
  .login-hero{padding:calc(22px + env(safe-area-inset-top)) 18px 34px}
  .login-hero h1{font-size:22px;margin:16px 0 6px}
  .login-hero p{font-size:14px;line-height:1.5;margin:0}
  .login-hero>p:last-child{display:none}
  .login-panel{padding:22px 16px 32px;place-items:start center;border-radius:20px 20px 0 0;margin-top:-18px;position:relative}
}
@media (max-width:340px){
  .kpis,.kpis.fees-kpis{grid-template-columns:1fr}
  .bn-item{font-size:10.5px}
}
`;
