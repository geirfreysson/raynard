import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // Bundled extensions deliberately use node:test because the builder and
    // catalog gate execute them with `node --test`. The catalog contract test
    // below scripts/ owns that execution; Vitest must not collect them again,
    // including the resource copies Tauri places under target/ while compiling.
    exclude: [
      ...configDefaults.exclude,
      'extensions/**/*.{test,spec}.{js,mjs,ts}',
      'src-tauri/target/**'
    ]
  },
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**']
    }
  }
});
