import type { JdLlm, JdLlmRequest } from '../../../modules/job-targets/jdLlm.js';
import type {
  CandidateInput,
  JdParseResult,
  JdScoreResult,
  JobTargetParsedOutboxInput,
  JobTargetPort,
  JobTargetRecord,
} from '../../../modules/job-targets/jobTarget.port.js';

export class InMemoryJobTargetPort implements JobTargetPort {
  targets = new Map<string, JobTargetRecord>();
  candidate: CandidateInput = { skills: [], evidence: [], experienceYears: 0, bullets: [] };
  scores = new Map<string, JdScoreResult>();
  events: JobTargetParsedOutboxInput[] = [];

  async loadTarget(userId: string, jobTargetId: string) {
    const target = this.targets.get(jobTargetId);
    return target && target.userId === userId ? structuredClone(target) : null;
  }
  async loadCandidateInput() { return structuredClone(this.candidate); }
  async saveParseResult(_userId: string, jobTargetId: string, result: JdParseResult) {
    this.targets.get(jobTargetId)!.parse = structuredClone(result);
  }
  async completeScore(_userId: string, jobTargetId: string, result: JdScoreResult, event: JobTargetParsedOutboxInput) {
    this.scores.set(jobTargetId, structuredClone(result));
    this.events.push(structuredClone(event));
  }
}

/** A model stand-in. `reply` can be text or a function of the request; a thrown error models a provider failure. */
export class FakeLlm implements JdLlm {
  calls: JdLlmRequest[] = [];
  constructor(public configured = true, public reply: string | ((request: JdLlmRequest) => string) = '{}') {}
  isConfigured() { return this.configured; }
  async complete(request: JdLlmRequest) {
    this.calls.push(request);
    return typeof this.reply === 'function' ? this.reply(request) : this.reply;
  }
}

export const JD_TEXT = [
  'About the role',
  'Acme builds payment tooling.',
  'Requirements:',
  'Strong TypeScript and Node.js experience, 3+ years of PostgreSQL.',
  'Nice to have: Docker, Kubernetes.',
].join('\n');

export function target(overrides: Partial<JobTargetRecord> = {}): JobTargetRecord {
  return { jobTargetId: 'jt1', userId: 'u1', jdText: JD_TEXT, ...overrides };
}
