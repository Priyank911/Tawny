import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'TAWNY_');
  const firebaseConfig = {
    apiKey: env.TAWNY_FIREBASE_API_KEY ?? '',
    projectId: env.TAWNY_FIREBASE_PROJECT_ID ?? '',
    googleClientId: env.TAWNY_GOOGLE_CLIENT_ID ?? '',
    googleClientSecret: env.TAWNY_GOOGLE_CLIENT_SECRET ?? ''
  };

  return {
    main: {
      define: {
        __TAWNY_FIREBASE_CONFIG__: JSON.stringify(firebaseConfig)
      },
      plugins: [externalizeDepsPlugin()]
    },
    preload: {
      build: { rollupOptions: { input: resolve('src/main/preload.ts') } },
      plugins: [externalizeDepsPlugin()]
    },
    renderer: {
      publicDir: resolve('public'),
      resolve: { alias: { '@renderer': resolve('src/renderer') } },
      build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
      plugins: [react()]
    }
  };
});
