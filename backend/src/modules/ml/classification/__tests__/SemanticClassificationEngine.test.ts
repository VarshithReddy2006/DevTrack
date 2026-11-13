import { describe, expect, it } from 'vitest';
import { SemanticClassificationEngine } from '../SemanticClassificationEngine.js';

const engine = new SemanticClassificationEngine();

describe('SemanticClassificationEngine', () => {
  it.each([
    ['summary', 'Professional Summary'],
    ['experience', '## Work Experience'],
    ['education', 'BSc degree from Example University'],
    ['skills', 'Core Competencies:'],
    ['projects', 'Selected Projects\nBuilt a personal dashboard using several frameworks'],
    ['certifications', 'Certified Kubernetes Administrator'],
    ['awards', 'Honors & Awards'],
    ['publications', 'Published in a technical journal'],
    ['other', 'Contact information'],
  ])('classifies a resume section as %s', (label, text) => {
    expect(engine.classify(text, 'resume_section').label).toBe(label);
  });

  it.each([
    ['project_authenticity', ['Notes', 'Docker', 'Docker deployed', 'Docker deployed 10 users', 'Docker deployed 10 users with Jest', 'Docker deployed 10 users with Jest and releases']],
    ['ats_semantic', ['Notes', 'Skills', 'Skills\nBuilt a service', 'Skills\nBuilt a service for 10 users', 'Skills\nBuilt a TypeScript service for 10 users']],
    ['recruiter_quality', ['Notes', 'Built a service', 'Built a service and reduced errors', 'Built a service and reduced errors by 50%', `Built a service and reduced errors by 50%. ${'Additional detail. '.repeat(6)}`]],
    ['infra_maturity', ['Notes', 'Docker', 'Docker Kubernetes', 'Docker Kubernetes CI/CD AWS', 'Docker Kubernetes CI/CD AWS Grafana']],
    ['engineering_depth', ['Notes', 'Designed a service', 'Designed a distributed service', 'Designed a distributed service for low latency', 'Designed a distributed microservice for low latency']],
  ] as const)('reaches every %s tier from lowest to highest', (task, inputs) => {
    const predictions = engine.classifyBatch([...inputs], task);
    expect(predictions.map(result => result.label)).toEqual([...engine.getLabels(task)].reverse());
    expect(predictions[0].evidenceCoverage).toBe(0);
    expect(predictions.at(-1)?.evidenceCoverage).toBe(1);
  });

  it('assigns greater probability to adjacent tiers and normalizes all task distributions', () => {
    for (const result of engine.classifyAll('Designed a distributed service').values()) {
      const probabilities = result.allLabels.map(entry => entry.probability);
      expect(probabilities.reduce((sum, probability) => sum + probability, 0)).toBeCloseTo(1);
      expect(result.probability).toBe(Math.max(...probabilities));
      expect(result.confidence).toBe(result.probability);
    }
    const { allLabels } = engine.classifyEngineeringDepth('Designed a distributed service');
    expect(allLabels[1].probability).toBeGreaterThan(allLabels[0].probability);
    expect(allLabels[3].probability).toBeGreaterThan(allLabels[4].probability);
  });

  it('gives an explicit heading more confidence than a keyword-only classification', () => {
    const heading = engine.classify('Technical Skills', 'resume_section');
    const keywords = engine.classify('Proficient in Rust and Python', 'resume_section');
    expect(keywords.label).toBe('skills');
    expect(heading.confidence).toBeGreaterThan(keywords.confidence);
  });
});
