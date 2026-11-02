import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['src/modules/resume/export/dossier*.test.ts', 'tests/dossier-smoke.test.ts'], testTimeout: 60000 } });
