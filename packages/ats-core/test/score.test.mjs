import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import * as core from '@devtrack/ats-core';

const fixtures = JSON.parse(await readFile(new URL('./legacy-score-fixtures.json', import.meta.url), 'utf8'));

function analyze(api, { content, keywords, targetRole, credibilityPenalty }) {
  const parserWarnings = api.validateParserSafety(content);
  const formattingWarnings = api.validateFormatting(content);
  const keywordCoverage = api.checkKeywordCoverage(content, keywords);
  const sectionIntegrity = api.validateSections(content);
  const extractionConfidence = api.calculateExtractionConfidence(parserWarnings, formattingWarnings, sectionIntegrity);
  const atsScore = api.calculateAtsScore({
    parserWarnings, formattingWarnings, keywordCoverage, sectionIntegrity, extractionConfidence, targetRole, credibilityPenalty,
  });
  const recommendations = api.generateRecommendations(parserWarnings, formattingWarnings, keywordCoverage, sectionIntegrity);
  return {
    parserWarnings, formattingWarnings, keywordCoverage, sectionIntegrity, extractionConfidence, atsScore, recommendations,
    wordCount: api.countResumeWords(content),
  };
}

for (const { input, expected } of fixtures) {
  test(input.name, () => {
    assert.equal(JSON.stringify(analyze(core, input)), JSON.stringify(expected));
  });
}

test('the browser bundle matches every legacy fixture', async () => {
  const { outputFiles } = await build({
    entryPoints: ['dist/index.js'],
    platform: 'browser',
    bundle: true,
    format: 'iife',
    globalName: 'atsCore',
    write: false,
  });
  const browserCore = runInNewContext(outputFiles[0].text + '\natsCore');
  for (const { input, expected } of fixtures) {
    assert.equal(JSON.stringify(analyze(browserCore, input)), JSON.stringify(expected), input.name);
  }
});

test('bullet parsing, impact and action verb diagnostics', () => {
  const bullets = core.splitBullets([
    '## Experience', '  - Reduced P99 latency by 25%', '2) Supported a team',
    '● Served 2,000 requests', '* Optimized cache', '•', '3.14 is not a bullet',
  ].join('\r\n'));

  assert.deepEqual(bullets, [
    'Reduced P99 latency by 25%', 'Supported a team', 'Served 2,000 requests', 'Optimized cache',
  ]);
  assert.deepEqual(core.analyzeQuantifiedImpact(bullets), [true, false, true, false]);
  assert.deepEqual(core.analyzeActionVerbs(bullets), [true, false, false, true]);
});

test('custom headings do not mutate stateful regular expressions', () => {
  const strengths = /^strengths$/gi;
  const headings = { strengths };
  assert.deepEqual(core.validateSections('Strengths:', headings), core.validateSections('Strengths:', headings));
  assert.equal(core.validateSections('## Strengths', headings)[0].detected, true);
  assert.equal(strengths.lastIndex, 0);
});
