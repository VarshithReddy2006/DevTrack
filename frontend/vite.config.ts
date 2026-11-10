import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      ...(process.env.DEVTRACK_E2E_FIXTURE === '1'
        ? { '@clerk/clerk-react': path.resolve(__dirname, './e2e/support/clerk.tsx') }
        : {}),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: process.env.DEVTRACK_E2E_FIXTURE === '1' ? 'http://127.0.0.1:3001' : 'http://localhost:3001',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  preview: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('framer-motion')) return 'framer-motion';
            if (id.includes('clsx') || id.includes('tailwind-merge')) return 'vendor-ui';
            if (id.includes('axios') || id.includes('zustand') || id.includes('zod') || id.includes('react-router-dom')) return 'vendor-core';
          }
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
})
