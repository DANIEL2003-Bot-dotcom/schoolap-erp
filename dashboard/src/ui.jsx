import { useState } from 'react';

/* Composants partagés : champ mot de passe avec bouton « afficher / masquer ». */

export const PASSWORD_CSS = `
.pwd-wrap{position:relative;display:block}
.pwd-wrap input{width:100%;padding-right:46px}
.pwd-toggle{position:absolute;top:50%;right:6px;transform:translateY(-50%);width:36px;height:36px;display:grid;place-items:center;border:0;border-radius:8px;background:transparent;color:#5B6B82;cursor:pointer}
.pwd-toggle:hover{background:rgba(29,78,137,.08);color:#0B2545}
.pwd-toggle:focus-visible{outline:2px solid #1D4E89;outline-offset:1px}
.pwd-toggle svg{width:20px;height:20px}
`;

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M17.94 17.94A10.6 10.6 0 0 1 12 19c-6.4 0-10-7-10-7a18.8 18.8 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.7 9.7 0 0 1 12 4c6.4 0 10 7 10 7a18.6 18.6 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <path d="M2 2l20 20" />
    </svg>
  );
}

/** Champ mot de passe : masqué par défaut, l'icône œil bascule l'affichage en clair. */
export function PasswordInput({ id, value, onChange, autoComplete = 'current-password', ...rest }) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="pwd-wrap">
      <input id={id} type={visible ? 'text' : 'password'} value={value} onChange={onChange} autoComplete={autoComplete} spellCheck={false} autoCapitalize="off" {...rest} />
      <button
        type="button"
        className="pwd-toggle"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
        aria-pressed={visible}
        aria-controls={id}
        title={visible ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </span>
  );
}
