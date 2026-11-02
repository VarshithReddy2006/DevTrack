import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readRootFile = (path: string) => readFileSync(`../${path}`, 'utf8');

describe('Docker Compose build contract', () => {
  it('builds the backend Dockerfile from the repository root in both topologies', () => {
    for (const file of ['docker-compose.yml', 'docker-compose.prod.yml']) {
      const compose = readRootFile(file);
      expect(compose).toContain('context: .');
      expect(compose).toContain('dockerfile: backend/Dockerfile');
      expect(compose).not.toContain('context: ./backend');
    }
  });

  it('passes only the public frontend configuration read by the application', () => {
    const compose = readRootFile('docker-compose.yml');
    const dockerfile = readRootFile('frontend/Dockerfile');

    expect(compose).toContain('VITE_API_BASE_URL:');
    expect(compose).toContain('VITE_CLERK_PUBLISHABLE_KEY:');
    expect(dockerfile).toContain('ARG VITE_API_BASE_URL');
    expect(dockerfile).toContain('ARG VITE_CLERK_PUBLISHABLE_KEY');
    expect(dockerfile).not.toContain('ARG CLERK_SECRET_KEY');
    expect(compose).not.toContain('VITE_API_URL:');
  });

  it('uses the real backend health endpoint and consistent container port', () => {
    const development = readRootFile('docker-compose.yml');
    const production = readRootFile('docker-compose.prod.yml');

    expect(development).toContain("fetch('http://127.0.0.1:3001/health')");
    expect(production).toContain('"${API_PORT:-4000}:3001"');
    expect(production).toContain('PORT=3001');
    expect(production).toContain("fetch('http://127.0.0.1:3001/health')");
    expect(production).not.toContain('/api/health');
  });
});
