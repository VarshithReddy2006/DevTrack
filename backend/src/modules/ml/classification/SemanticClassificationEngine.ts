// src/modules/ml/classification/SemanticClassificationEngine.ts
// Streamlined semantic classification engine using deterministic heuristics.

import { logger } from '../../../shared/logger.js';
import type { ClassificationPrediction } from '../types.js';

type ClassificationTask =
  | 'resume_section'
  | 'project_authenticity'
  | 'ats_semantic'
  | 'recruiter_quality'
  | 'infra_maturity'
  | 'engineering_depth';

interface ClassificationWithEvidence extends ClassificationPrediction {
  task: ClassificationTask;
  evidence: string[];
  evidenceCoverage: number;
}

const TASK_LABELS: Record<ClassificationTask, string[]> = {
  resume_section: [
    'summary', 'experience', 'education', 'skills', 'projects',
    'certifications', 'awards', 'publications', 'other',
  ],
  project_authenticity: [
    'authentic_production', 'authentic_learning', 'tutorial_derivative',
    'template_based', 'suspicious', 'insufficient_evidence',
  ],
  ats_semantic: [
    'highly_optimized', 'well_optimized', 'partially_optimized',
    'poorly_optimized', 'not_optimized',
  ],
  recruiter_quality: [
    'exceptional', 'strong', 'adequate', 'needs_work', 'poor',
  ],
  infra_maturity: [
    'production_grade', 'staging_ready', 'development_only',
    'prototype', 'minimal',
  ],
  engineering_depth: [
    'expert', 'advanced', 'intermediate', 'beginner', 'novice',
  ],
};

const RESUME_SECTION_SIGNALS: Record<string, { heading: RegExp; body: RegExp }> = {
  summary: { heading: /^(?:(?:professional|career) )?(?:summary|profile|objective)$|^about me$/i, body: /\b(?:professional summary|career objective|years of experience)\b/i },
  experience: { heading: /^(?:(?:professional|work|relevant) )?experience$|^(?:work|employment|career) history$/i, body: /\b(?:worked at|employed by|responsible for|internship)\b/i },
  education: { heading: /^(?:education|academic background|education & credentials)$/i, body: /\b(?:bachelor(?:'s)?|master(?:'s)?|degree|university|gpa)\b/i },
  skills: { heading: /^(?:skills|technical skills|technical stack|core competencies|technologies & tools)$/i, body: /\b(?:programming languages|proficient in|frameworks|technical skills)\b/i },
  projects: { heading: /^(?:(?:selected|personal|key) )?projects$|^(?:portfolio|open source contributions)$/i, body: /\b(?:personal project|side project|project repository|open source contribution)\b/i },
  certifications: { heading: /^(?:certifications?|certificates|licenses & certifications)$/i, body: /\b(?:certified|certification|certificate|credential id)\b/i },
  awards: { heading: /^(?:awards|honou?rs|honou?rs & awards|awards & honou?rs)$/i, body: /\b(?:award(?:ed)?|first place|winner|honou?rable mention)\b/i },
  publications: { heading: /^(?:publications?|research publications|selected publications)$/i, body: /\b(?:published in|doi|journal article|conference paper)\b/i },
};

/**
 * SemanticClassificationEngine
 * 
 * Heuristic-driven lightweight classifier. Zero matrix-multiply CPU usage.
 */
export class SemanticClassificationEngine {
  constructor() {
    logger.info('[SemanticClassificationEngine] Streamlined heuristic classifier initialized');
  }

  /**
   * Classify text for a specific task using deterministic heuristic score calculations.
   */
  classify(text: string, task: ClassificationTask): ClassificationWithEvidence {
    const labels = TASK_LABELS[task];
    let evidence: string[];
    let evidenceCoverage: number;
    let weights: number[];

    if (task === 'resume_section') {
      const result = this.scoreResumeSections(text, labels);
      ({ evidence, evidenceCoverage, weights } = result);
    } else {
      evidence = this.extractEvidence(text, task);
      const maxEvidence = task === 'infra_maturity' ? 5 : labels.length - 1;
      evidenceCoverage = Math.min(1, evidence.length / maxEvidence);
      // Nearby tiers get more weight, with lower confidence at tier boundaries.
      const position = (1 - evidenceCoverage) * (labels.length - 1);
      weights = labels.map((_, index) => Math.exp(-2 * Math.abs(position - index)));
    }

    const selectedIndex = weights.reduce((best, weight, index) => weight > weights[best] ? index : best, 0);
    const totalWeight = weights.reduce((total, weight) => total + weight, 0);
    const allLabels = labels.map((label, index) => ({ label, probability: weights[index] / totalWeight }));
    const { label, probability } = allLabels[selectedIndex];

    return {
      label,
      probability,
      confidence: probability,
      allLabels,
      modelId: 'heuristic-classifier-v1',
      modelVersion: '1.0.0',
      latencyMs: 1,
      timestamp: new Date().toISOString(),
      task,
      evidence: evidence.length ? evidence : ['Limited context signal for classification'],
      evidenceCoverage,
    };
  }

  /**
   * Run all classification tasks on text.
   */
  classifyAll(text: string): Map<ClassificationTask, ClassificationWithEvidence> {
    const results = new Map<ClassificationTask, ClassificationWithEvidence>();
    for (const task of Object.keys(TASK_LABELS) as ClassificationTask[]) {
      results.set(task, this.classify(text, task));
    }
    return results;
  }

  classifyProjectAuthenticity(projectDescription: string): ClassificationWithEvidence {
    return this.classify(projectDescription, 'project_authenticity');
  }

  classifyEngineeringDepth(text: string): ClassificationWithEvidence {
    return this.classify(text, 'engineering_depth');
  }

  classifyInfraMaturity(text: string): ClassificationWithEvidence {
    return this.classify(text, 'infra_maturity');
  }

  classifyBatch(texts: string[], task: ClassificationTask): ClassificationWithEvidence[] {
    return texts.map(text => this.classify(text, task));
  }

  getSupportedTasks(): ClassificationTask[] {
    return Object.keys(TASK_LABELS) as ClassificationTask[];
  }

  getLabels(task: ClassificationTask): string[] {
    return TASK_LABELS[task];
  }

  private scoreResumeSections(text: string, labels: string[]) {
    const heading = text.trim().split(/\r?\n/, 1)[0]
      .replace(/^#{1,6}\s+/, '').replace(/:$/, '').trim();
    const evidence: string[] = [];
    let strongestScore = 0;
    const scores = labels.map(label => {
      const signals = RESUME_SECTION_SIGNALS[label];
      if (!signals) return 0;
      const headingMatches = signals.heading.test(heading);
      const bodyMatches = signals.body.test(text);
      if (headingMatches) evidence.push(`Section heading matches ${label}`);
      if (bodyMatches) evidence.push(`Section text matches ${label}`);
      const score = Number(headingMatches) * 3 + Number(bodyMatches);
      strongestScore = Math.max(strongestScore, score);
      return score;
    });
    const weights = scores.map((score, index) => Math.exp(
      labels[index] === 'other' && strongestScore === 0 ? 1 : score
    ));
    return { evidence, evidenceCoverage: strongestScore / 4, weights };
  }

  private extractEvidence(text: string, task: Exclude<ClassificationTask, 'resume_section'>): string[] {
    const evidence: string[] = [];
    const lower = text.toLowerCase();

    switch (task) {
      case 'project_authenticity':
        if (/docker|kubernetes|ci\/cd/i.test(lower)) evidence.push('Infrastructure tooling detected');
        if (/deployed|production|live/i.test(lower)) evidence.push('Deployment evidence found');
        if (/\d+ (users|requests|commits)/i.test(lower)) evidence.push('Quantified metrics present');
        if (/test|testing|jest|vitest|mocha/i.test(lower)) evidence.push('Testing evidence found');
        if (/\b(?:maintained|maintainer|contributors?|releases?)\b/.test(lower)) evidence.push('Maintenance evidence found');
        break;

      case 'infra_maturity':
        if (/docker/i.test(lower)) evidence.push('Docker containerization');
        if (/kubernetes|k8s/i.test(lower)) evidence.push('Kubernetes orchestration');
        if (/ci\/cd|github actions|jenkins/i.test(lower)) evidence.push('CI/CD pipeline');
        if (/aws|azure|gcp|cloud/i.test(lower)) evidence.push('Cloud deployment');
        if (/monitoring|prometheus|grafana/i.test(lower)) evidence.push('Monitoring setup');
        break;

      case 'engineering_depth':
        if (/architect|designed|system design/i.test(lower)) evidence.push('Architecture work');
        if (/scaled|scalab|distributed/i.test(lower)) evidence.push('Scalability experience');
        if (/optimiz|performance|latency/i.test(lower)) evidence.push('Performance optimization');
        if (/microservice|event-driven|message queue/i.test(lower)) evidence.push('Advanced patterns');
        break;

      case 'recruiter_quality':
        if (/\d+%|\d+x/i.test(lower)) evidence.push('Quantified achievements');
        if (/(built|designed|implemented|architected)\s/i.test(lower)) evidence.push('Action verbs present');
        if (text.length > 100) evidence.push('Sufficient detail');
        if (/\b(?:reduced|increased|improved|saved|delivered)\b/.test(lower)) evidence.push('Outcome described');
        break;

      case 'ats_semantic':
        if (/^\s*(?:professional experience|work experience|experience|education|skills|projects)\s*:?\s*$/im.test(text)) evidence.push('Standard resume heading present');
        if (/\b(?:built|designed|implemented|led|developed)\b/.test(lower)) evidence.push('Action verbs present');
        if (/\b\d+(?:\.\d+)?(?:%|x\b|\s+(?:users|requests|projects)\b)/.test(lower)) evidence.push('Quantified achievement present');
        if (/\b(?:typescript|python|java|sql|react|docker|kubernetes|aws)\b/.test(lower)) evidence.push('Specific technical keywords present');
        break;
    }

    return evidence;
  }
}
