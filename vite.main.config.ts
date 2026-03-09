import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['node-pty', 'uiohook-napi', 'ws', 'bufferutil', 'utf-8-validate'],
    },
  },
});
