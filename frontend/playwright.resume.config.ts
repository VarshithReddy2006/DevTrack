import { defineConfig, devices } from '@playwright/test';

// Runs only the resume browser flow against a disposable API, MongoDB and Redis.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'resume-ats-flow.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 150_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }], ['junit', { outputFile: 'test-results/resume-junit.xml' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run test:e2e:server --prefix ../backend',
      url: 'http://127.0.0.1:3001/health',
      reuseExistingServer: false,
      timeout: 120_000,
      env: { NODE_ENV: 'test', DEVTRACK_E2E_FIXTURE: '1',
        REDIS_URL: 'redis://127.0.0.1:6379/15', MONGOMS_MD5_CHECK: '0' },
    },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 5173',
      url: 'http://127.0.0.1:5173/resume',
      reuseExistingServer: false,
      timeout: 120_000,
      env: { DEVTRACK_E2E_FIXTURE: '1', VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_resume_fixture',
        VITE_API_BASE_URL: '/api' },
    },
  ],
});
