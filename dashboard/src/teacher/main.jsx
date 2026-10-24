import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import TeacherApp from './TeacherApp.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <TeacherApp />
  </StrictMode>,
);

// Service worker : application disponible hors ligne (uniquement sur la version publiée).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((err) => console.warn('Service worker non enregistré :', err));
  });
}
