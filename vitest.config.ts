import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@Contexts': path.resolve(__dirname, './src/Contexts'),
      '@Features': path.resolve(__dirname, './src/Features'),
      '@Pages': path.resolve(__dirname, './src/Pages'),
      '@app-types': path.resolve(__dirname, './src/app-types'),
      '@config': path.resolve(__dirname, './src/config'),
      '@images': path.resolve(__dirname, './src/images'),
      '@lib': path.resolve(__dirname, './src/lib'),
    },
  },
})
