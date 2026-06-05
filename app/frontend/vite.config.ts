/// <reference types="vitest" />
import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'

// Under Vitest we skip the React Fast-Refresh plugin: it injects a browser
// preamble the test runner doesn't provide ("can't detect preamble"), and
// our unit tests exercise pure logic rather than rendering components.
const isTest = !!process.env.VITEST

// https://vitejs.dev/config/
export default defineConfig({
  plugins: isTest ? [] : [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.{test,spec}.{ts,tsx}', 'src/vite-env.d.ts', 'src/main.tsx'],
    },
  },
})
