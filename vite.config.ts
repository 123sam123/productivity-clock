import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Deployed as a GitHub Pages project site, so everything is served under /<repo>/.
// Applied unconditionally: dev and preview must reproduce the production URL
// shape, or a base-path break only surfaces after deploy.
export default defineConfig({
  base: '/productivity-clock/',
  plugins: [react()],
})
