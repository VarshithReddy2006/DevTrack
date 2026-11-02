import assert from 'node:assert/strict';
import test from 'node:test';
import { isSupportedNodeVersion } from './nodeVersion.js';

test('accepts the declared Node release boundaries', () => {
  for (const version of ['v22.13.0', 'v22.23.1', 'v24.0.0', 'v25.1.0']) {
    assert.equal(isSupportedNodeVersion(version), true, version);
  }
});

test('rejects versions outside the supported ranges', () => {
  for (const version of ['v18.20.0', 'v20.19.0', 'v22.12.9', 'v23.11.0', 'invalid']) {
    assert.equal(isSupportedNodeVersion(version), false, version);
  }
});
