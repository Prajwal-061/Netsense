import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Fail instead of moving to another port: the backend's CORS list
    // allows this exact origin (host + port).
    strictPort: true,
  },
  test: {
    // jsdom is a simulated browser, so components render without a real one.
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    // e2e/ holds the Playwright browser tests (npm run test:browser).
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
})
