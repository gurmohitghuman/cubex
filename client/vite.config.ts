import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Vite is invoked from the repo root, so we anchor the project to client/.
// The factory form lets us inspect the `command` (serve vs build) so we can
// strip console.* only in production builds.
export default defineConfig(({ command }) => ({
  root: __dirname,
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3002',
        changeOrigin: true
      },
      // The MCP server lives on Express too. Without this, the endpoint the
      // settings "Connect an AI agent" card derives from window.location.origin
      // points at Vite in dev and connecting fails.
      '/mcp': {
        target: 'http://localhost:3002',
        changeOrigin: true
      }
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  css: {
    postcss: path.join(__dirname, 'postcss.config.js'),
  },
  build: {
    outDir: 'dist',
    minify: 'esbuild',
    rollupOptions: {
      output: {
        // Split the two large vendor groups into their own chunks. AG Grid is
        // ~300KB gzip (>half the JS) and is only needed by the lazy-loaded
        // SheetPage, so keeping it out of the main chunk means login/dashboard/
        // settings first-paint downloads ~250KB instead of ~550KB. react is
        // split too so it caches independently across deploys. See PERF_AUDIT.md "L1".
        manualChunks: {
          aggrid: ['ag-grid-community', 'ag-grid-react'],
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
  // Strip console.* and debugger from the production bundle only. Internal
  // flow logs throughout SheetPage/AGGridSpreadsheet/modals leak API
  // response shapes and timing diagnostics to anyone with DevTools open.
  // The dev server (command === 'serve') keeps them — they're useful while
  // building.
  esbuild: command === 'build'
    ? { drop: ['console', 'debugger'] }
    : {},
}))
