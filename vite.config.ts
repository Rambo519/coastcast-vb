import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Dev-only: browser calls same-origin `/api/...`; Vite forwards to NHC (avoids CORS).
    proxy: {
      '/api/nhc-current-storms': {
        target: 'https://www.nhc.noaa.gov',
        changeOrigin: true,
        rewrite: () => '/CurrentStorms.json',
      },
      '/api/usno-oneday': {
        target: 'https://aa.usno.navy.mil',
        changeOrigin: true,
        rewrite: () => '/api/rstt/oneday',
      },
    },
  },
})
