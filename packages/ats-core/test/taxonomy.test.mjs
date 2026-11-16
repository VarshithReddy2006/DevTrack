import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { extractRequirements, matchScore, SKILL_TAXONOMY_VERSION } from '@devtrack/ats-core';

const postings = [
  {
    jd: [
      'About the company',
      'We started 10 years ago.',
      '## Minimum Qualifications',
      '- 5+ years of Go / distributed systems.',
      '- PostgreSQL, Postgres and psql. Familiarity with SQL Server.',
      'Nice to have: Kafka, K8s and C++.',
    ].join('\r\n'),
    skills: ['Go', 'Distributed Systems', 'PostgreSQL', 'SQL Server', 'Kafka', 'Kubernetes', 'C++'],
    experience: [{ minYears: 5, skills: ['Go', 'Distributed Systems'], section: 'Minimum Qualifications', priority: 'required' }],
  },
  {
    jd: [
      '**Requirements:** 3–5 years with React.js and TypeScript; 2 years of Node.js.',
      'Preferred qualifications',
      'Familiarity with WCAG and Vue.js.',
      '### Tech stack',
      'PostgreSQL, REST APIs, Next.js.',
    ].join('\n'),
    skills: ['React', 'TypeScript', 'Node.js', 'Accessibility', 'Vue.js', 'PostgreSQL', 'REST', 'Next.js'],
    experience: [
      { minYears: 3, skills: ['React', 'TypeScript'], section: 'Requirements', priority: 'required' },
      { minYears: 2, skills: ['Node.js'], section: 'Requirements', priority: 'required' },
    ],
  },
  {
    jd: [
      'Required Skills',
      'C# and .NET (ASP.NET Core); 1.5 yrs with GCP and Apache Kafka.',
      '5 years of professional experience.',
      'Docker is a plus. Go to the application page for the rest of the process.',
      'Bonus: Terraform, OpenTelemetry, and PySpark.',
    ].join('\n'),
    skills: ['C#', '.NET', 'Google Cloud', 'Kafka', 'Docker', 'Terraform', 'OpenTelemetry', 'Apache Spark'],
    experience: [
      { minYears: 1.5, skills: ['Google Cloud', 'Kafka'], section: 'Required Skills', priority: 'required' },
      { minYears: 5, skills: [], section: 'Required Skills', priority: 'required' },
    ],
  },
];

for (const [index, fixture] of postings.entries()) {
  test('extracts canonical skills and experience from job posting ' + (index + 1), () => {
    const requirements = extractRequirements(fixture.jd);
    assert.equal(requirements.taxonomyVersion, SKILL_TAXONOMY_VERSION);
    assert.equal(requirements.taxonomyVersion, 'v1');
    assert.deepEqual(requirements.skills.map(item => item.skill), fixture.skills);
    assert.deepEqual(requirements.experience, fixture.experience);
  });
}

test('tracks alias frequency and priority without treating substrings as skills', () => {
  const { skills } = extractRequirements(postings[0].jd + '\nAbout the role: PostgreSQL.\nJavaScripted psqltools no_go');
  assert.deepEqual(skills.find(item => item.skill === 'PostgreSQL'), {
    skill: 'PostgreSQL',
    category: 'database',
    frequency: 4,
    contexts: [
      { section: 'Minimum Qualifications', priority: 'required', frequency: 3 },
      { section: 'About the role', priority: 'unspecified', frequency: 1 },
    ],
  });
  assert.deepEqual(skills.find(item => item.skill === 'Kafka').contexts, [
    { section: 'Nice to have', priority: 'preferred', frequency: 1 },
  ]);
  assert.ok(!skills.some(item => item.skill === 'JavaScript'));
});

test('separates explicit mixed priorities and takes the lower end of a range', () => {
  const result = extractRequirements('3 to 5 years of Python required, Docker preferred.');
  assert.deepEqual(result.experience, [
    { minYears: 3, skills: ['Python'], section: 'General', priority: 'required' },
  ]);
  assert.deepEqual(result.skills.map(term => term.contexts[0].priority), ['required', 'preferred']);
});

test('weights hard skills, stack, verified evidence and experience independently', () => {
  const requirements = extractRequirements('Requirements: 4 years of PostgreSQL and Go.\nNice to have: Kafka and Docker.');
  const candidate = [{ skill: 'PSQL', years: 2 }, { skill: 'postgres', years: 1 }, 'apache kafka'];
  const evidence = [{ skill: 'postgres', verified: true }, { skill: 'docker', verified: false }];
  const expected = {
    source: 'taxonomy_only',
    taxonomyVersion: 'v1',
    score: 42.5,
    dimensions: { hardRequirements: 50, techStack: 50, verifiedEvidence: 25, experience: 25 },
  };
  assert.deepEqual(matchScore(requirements, candidate, evidence), expected);
  assert.deepEqual(matchScore(requirements, [...candidate].reverse(), [...evidence].reverse()), expected);
});

test('handles missing dimensions and supports an overall experience requirement', () => {
  const empty = matchScore(extractRequirements(''), [], []);
  assert.equal(empty.score, 0);
  assert.deepEqual(Object.values(empty.dimensions), [null, null, null, null]);

  const experienceOnly = extractRequirements('Qualifications: 5 years of professional experience.');
  assert.equal(matchScore(experienceOnly, [], [], 2.5).score, 50);
  assert.equal(matchScore(experienceOnly, [], [], Infinity).score, 0);
  assert.equal(matchScore(experienceOnly, [], [], 7).score, 100);
});

test('matches Node extraction and scoring in the browser bundle', async () => {
  const { outputFiles } = await build({
    entryPoints: ['dist/index.js'],
    platform: 'browser',
    bundle: true,
    format: 'iife',
    globalName: 'atsCore',
    write: false,
  });
  const browser = runInNewContext(outputFiles[0].text + '\natsCore');
  for (const fixture of postings) {
    const requirements = extractRequirements(fixture.jd);
    const candidate = [{ skill: 'Go', years: 5 }, 'postgres', 'react'];
    const evidence = [{ skill: 'psql', verified: true }];
    const browserRequirements = browser.extractRequirements(fixture.jd);
    assert.equal(JSON.stringify(browserRequirements), JSON.stringify(requirements));
    assert.equal(
      JSON.stringify(browser.matchScore(browserRequirements, candidate, evidence)),
      JSON.stringify(matchScore(requirements, candidate, evidence)),
    );
  }
});
