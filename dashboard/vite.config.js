import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages sert le site sous https://<compte>.github.io/<dépôt>/ :
// la base doit donc être "/<dépôt>/" en production (VITE_BASE, "/schoolap-erp/" par défaut).
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const base = command === 'build' ? env.VITE_BASE || '/schoolap-erp/' : '/';
  return {
    base,
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 5174,
      allowedHosts: true,
      // Avec VITE_API_URL="" le navigateur appelle /api sur la même origine, relayé vers l'API locale.
      // L'en-tête Origin est retiré : l'appel devient serveur-à-serveur et n'est pas soumis au CORS de l'API.
      proxy: {
        '/api': {
          target: env.API_PROXY_TARGET || 'http://localhost:4000',
          configure: (proxy) => proxy.on('proxyReq', (proxyReq) => proxyReq.removeHeader('origin')),
        },
      },
    },
    preview: { host: '0.0.0.0', port: 4174, allowedHosts: true },
    build: { outDir: 'dist', sourcemap: false },
  };
});
