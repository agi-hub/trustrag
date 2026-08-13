import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/trustrag/',
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3010',
        changeOrigin: true,
      },
    },
  },
})
