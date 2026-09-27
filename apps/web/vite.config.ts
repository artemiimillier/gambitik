import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Keep in sync with WEB_DEV_PORT / SERVER_PORT / API_BASE in packages/shared/src/contracts.ts.
// GAMBIT_WEB_PORT / GAMBIT_API_PORT move a second dev stack (e2e while the family server runs on 8787) to other ports;
// the server reads the same variables (apps/server/src/config.ts).
function portFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 1024 && value <= 65_535 ? value : fallback;
}
const WEB_DEV_PORT = portFromEnv('GAMBIT_WEB_PORT', 5173);
const SERVER_ORIGIN = `http://127.0.0.1:${portFromEnv('GAMBIT_API_PORT', 8787)}`;

/**
 * Content-Security-Policy as a <meta> of the PRODUCTION bundle only: the Vite dev server needs an
 * inline React-refresh preamble and an HMR web socket, which this policy would (rightly) refuse.
 * Keep in sync with CONTENT_SECURITY_POLICY in apps/server/src/security.ts — the server sends the same list as a
 * response header (plus `frame-ancestors`, which a meta tag cannot carry).
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' https://api.openai.com wss://api.openai.com",
  "media-src 'self' blob:",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function cspMeta(): Plugin {
  return {
    name: 'gambit-csp-meta',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY }, injectTo: 'head-prepend' },
    ],
  };
}

export default defineConfig({
  plugins: [react(), cspMeta()],
  // Every screen is lazy-loaded. Without this list Vite discovers react-chessboard / recharts / confetti only when
  // their screen opens for the first time, re-optimises and RELOADS the page in the middle of the session
  // (a cold `pnpm dev`, the first e2e run on a fresh checkout). Pre-bundle them at start-up instead.
  optimizeDeps: {
    include: [
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-dom',
      'react-dom/client',
      'zustand',
      'zustand/vanilla',
      'chess.js',
      'react-chessboard',
      'recharts',
      'canvas-confetti',
    ],
  },
  server: {
    // Local only. `http://localhost:5173` keeps working: browsers fall back from ::1 to 127.0.0.1.
    host: '127.0.0.1',
    port: WEB_DEV_PORT,
    strictPort: true,
    proxy: {
      '/api': {
        target: SERVER_ORIGIN,
        // The server has a Host allowlist; present the proxied request as 127.0.0.1:<api port>.
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: WEB_DEV_PORT,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
