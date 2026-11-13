import { describe, expect, it } from 'vitest';
import { CommunicationIntelligenceEngine as engine } from './CommunicationIntelligenceEngine.js';

const readme = [
  '# Example service',
  'This service processes queued reports.',
  '## Overview',
  'Workers handle export requests.',
  '## Architecture',
  'The API writes to a queue.',
  '~~~mermaid',
  'flowchart LR',
  '  API --> Worker',
  '~~~',
  '## Setup',
  'Install the dependencies.',
  '~~~bash',
  'npm ci',
  'npm run dev',
  '~~~',
  '### Environment configuration',
  'Set the database URL before startup.',
  '## API',
  'GET /reports returns the latest reports.',
].join('\n');

const pullRequest = [
  '## Summary',
  'Persist pending report exports so a worker can resume after a process restart.',
  '## Motivation',
  'Previously a restart could leave customers waiting for an export that would never finish.',
  'Fixes #123',
  '## Testing',
  '1. Submit a report export and stop the worker.',
  '2. Restart the worker and verify that it finishes the pending export.',
].join('\n');

describe('CommunicationIntelligenceEngine', () => {
  it('scores empty, unrelated, and unstructured boilerplate low', () => {
    expect(engine.analyzeArtifacts([])).toEqual({
      documentationQuality: 0,
      technicalExplanationClarity: 0,
      communicationMaturity: 0,
    });
    expect(engine.analyzeArtifacts([
      { type: 'readme', content: 'lorem ipsum '.repeat(200) },
      { type: 'readme', content: '' },
      { type: 'comment', content: pullRequest },
      { type: 'pr', content: 'lorem ipsum '.repeat(200) },
    ]).communicationMaturity).toBe(0);
  });

  it('recognizes documented sections, code examples, diagrams, and structured PR explanations', () => {
    const scores = engine.analyzeArtifacts([
      { type: 'readme', content: readme },
      { type: 'pr', content: pullRequest, changedLines: 100 },
    ]);
    expect(scores.documentationQuality).toBeGreaterThanOrEqual(90);
    expect(scores.technicalExplanationClarity).toBeGreaterThanOrEqual(90);
    expect(scores.communicationMaturity).toBeLessThanOrEqual(100);
  });

  it('scores a GFM table as evidence and does not count fenced headings or hidden template instructions', () => {
    const withTable = '# App\nExample app.\n## API\n| Route | Method |\n| --- | --- |\n| / | GET |';
    const withoutTable = '# App\nExample app.\n## API\nGET /.';
    expect(engine.analyzeArtifacts([{ type: 'readme', content: withTable }]).documentationQuality)
      .toBeGreaterThan(engine.analyzeArtifacts([{ type: 'readme', content: withoutTable }]).documentationQuality);

    const fake = '## Summary\n<!-- Add details here #99 -->\n## Testing\n- [ ]\n## Motivation';
    expect(engine.analyzeArtifacts([{ type: 'pr', content: fake }]).technicalExplanationClarity).toBe(0);
    const fenced = '~~~markdown\n## Summary\nFixes #99\n1. Reproduce the bug\n~~~';
    expect(engine.analyzeArtifacts([{ type: 'pr', content: fenced }]).technicalExplanationClarity).toBeLessThanOrEqual(10);
  });

  it('averages PR quality and accounts for optional change size', () => {
    const tiny = { type: 'pr', content: '## Summary\nFix typo.' };
    const single = engine.analyzeArtifacts([tiny]).technicalExplanationClarity;
    expect(engine.analyzeArtifacts(Array(50).fill(tiny)).technicalExplanationClarity).toBe(single);
    expect(single).toBeLessThan(30);

    const score = (changedLines?: number) => engine.analyzeArtifacts([
      { type: 'pr', content: pullRequest, changedLines },
    ]).technicalExplanationClarity;
    expect(score(100)).toBeGreaterThan(score(800));
    expect(score(NaN)).toBe(score());
  });
});
