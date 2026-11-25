// backend/src/__tests__/modules/resume/typstCompiler.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PDFParse } from 'pdf-parse';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  typstCompilerService,
  TypstCompilerService,
} from '../../../modules/resume/export/typstCompiler.service.js';
import {
  generateTypstTemplate,
  generateLatexTemplate,
  escapeTypst,
  escapeLatex,
  normalizeSkills,
  type StructuredResume,
} from '../../../modules/resume/export/latexTemplates.js';
import { processResumeRenderJob } from '../../../workers/worker-render.js';

describe('TypstCompilerService & LaTeX Resume Engine', () => {
  const sampleResume: StructuredResume = {
    header: {
      name: 'Samantha Vance',
      title: 'Senior Distributed Systems Engineer',
      email: 'samantha.vance@techcorp.io',
      phone: '+1 (555) 019-2834',
      location: 'Seattle, WA',
      github: 'svance-systems',
      linkedin: 'samanthavance',
      website: 'https://svance.io',
    },
    summary:
      'High-performance backend engineer specializing in distributed consensus, WebAssembly runtimes, and low-latency stream processing. Track record of optimizing P99 latencies and leading tier-1 infrastructure migrations.',
    skills: [
      { category: 'Languages', skills: ['Rust', 'Go', 'TypeScript', 'C++', 'Python', 'SQL'] },
      { category: 'Systems & Storage', skills: ['Kafka', 'Redis Sentinel', 'Raft Consensus', 'PostgreSQL', 'RocksDB'] },
      { category: 'Cloud & DevOps', skills: ['Docker', 'Kubernetes', 'AWS', 'WASM', 'Terraform', 'Prometheus'] },
    ],
    experience: [
      {
        role: 'Staff Infrastructure Architect',
        company: 'HyperScale Cloud Labs',
        location: 'Seattle, WA',
        startDate: 'Jan 2022',
        endDate: 'Present',
        bullets: [
          'Engineered an isolated WebAssembly (WASI) execution runtime processing 100k+ daily candidate evaluations.',
          'Reduced memory consumption by 45% using V8 heap snapshotting and deterministic memory page recycling.',
          'Built multi-region Redis Sentinel failover engine with automated master election and split-brain mitigation.',
        ],
        technologies: ['Rust', 'WASI', 'Docker', 'Redis', 'TypeScript'],
      },
      {
        role: 'Senior Backend Engineer',
        company: 'DataFlow Systems',
        location: 'Austin, TX',
        startDate: 'Mar 2019',
        endDate: 'Dec 2021',
        bullets: [
          'Spearheaded transition from monolith to event-driven microservices handling 75k RPS peak traffic.',
          'Authored high-throughput zero-copy Protobuf serialization pipeline improving network utilization by 34%.',
          'Automated canary deployment pipelines in Kubernetes, driving deploy failure rates down to < 0.1%.',
        ],
        technologies: ['Go', 'gRPC', 'Kubernetes', 'Kafka', 'PostgreSQL'],
      },
    ],
    projects: [
      {
        name: 'WasmSandbox',
        role: 'Creator & Lead Maintainer',
        url: 'https://github.com/svance-systems/wasmsandbox',
        startDate: '2023',
        endDate: '2024',
        bullets: [
          'Lightweight WebAssembly capability-based sandbox engine with microsecond cold starts and strict CPU quotas.',
          'Garnered 1,800+ GitHub stars and adopted by multiple technical assessment platforms.',
        ],
        technologies: ['Rust', 'Wasmtime', 'Linux cgroups'],
      },
    ],
    education: [
      {
        degree: 'B.S. in Computer Science & Engineering',
        institution: 'University of Washington',
        location: 'Seattle, WA',
        endDate: 'Jun 2019',
        gpa: '3.94 / 4.0',
        honors: ['Magna Cum Laude', 'Dean\'s Medal in Engineering'],
        coursework: ['Distributed Systems', 'Operating Systems Internals', 'Compilers & Languages'],
      },
    ],
  };

  // 1. Syntax Escaping Tests
  describe('Syntax Escaping', () => {
    it('correctly escapes special Typst characters without syntax corruption', () => {
      const dangerous = 'C++ with O(N) complexity & $100k revenue, email: test@domain.com #winner *bold* _italics_ [block] <label>';
      const escaped = escapeTypst(dangerous);

      expect(escaped).toContain('test\\@domain.com');
      expect(escaped).toContain('\\#winner');
      expect(escaped).toContain('\\$100k');
      expect(escaped).toContain('\\*bold\\*');
      expect(escaped).toContain('\\_italics\\_');
      expect(escaped).toContain('\\[block\\]');
      expect(escaped).toContain('\\<label\\>');
    });

    it('correctly escapes special LaTeX characters', () => {
      const dangerous = '100% of $50 & 50# with {tags} and ~carat^';
      const escaped = escapeLatex(dangerous);

      expect(escaped).toContain('100\\%');
      expect(escaped).toContain('\\$50');
      expect(escaped).toContain('\\&');
      expect(escaped).toContain('\\#');
      expect(escaped).toContain('\\{tags\\}');
    });

    it('handles empty or null inputs safely in escaping', () => {
      expect(escapeTypst('')).toBe('');
      expect(escapeTypst(null)).toBe('');
      expect(escapeTypst(undefined)).toBe('');

      expect(escapeLatex('')).toBe('');
      expect(escapeLatex(null)).toBe('');
      expect(escapeLatex(undefined)).toBe('');
    });
  });

  // 2. Skill Normalization Tests
  describe('Skill Normalization', () => {
    it('normalizes flat array of strings into categorized structure', () => {
      const flat = ['Rust', 'Go', 'Docker'];
      const normalized = normalizeSkills(flat);
      expect(normalized).toHaveLength(1);
      expect(normalized[0].category).toBe('Core Skills');
      expect(normalized[0].skills).toEqual(flat);
    });

    it('normalizes object format into category array', () => {
      const obj = { Frontend: ['React', 'CSS'], Backend: ['Node.js', 'PostgreSQL'] };
      const normalized = normalizeSkills(obj);
      expect(normalized).toHaveLength(2);
      expect(normalized[0].category).toBe('Frontend');
      expect(normalized[0].skills).toEqual(['React', 'CSS']);
    });
  });

  // 3. Template Generation Tests
  describe('Template Markup Generation', () => {
    it('generates Classic Academic Typst markup with serif styling', () => {
      const markup = generateTypstTemplate('classic-academic', sampleResume);
      expect(markup).toContain('Linux Libertine');
      expect(markup).toContain('Samantha Vance');
      expect(markup).toContain('Staff Infrastructure Architect');
      expect(markup).toContain('HyperScale Cloud Labs');
      expect(markup).toContain('WasmSandbox');
      expect(markup).toContain('University of Washington');
    });

    it('generates Modern Tech Typst markup with sans-serif styling and color accents', () => {
      const markup = generateTypstTemplate('modern-tech', sampleResume);
      expect(markup).toContain('Roboto');
      expect(markup).toContain('rgb("#2563eb")');
      expect(markup).toContain('Technical Proficiencies');
      expect(markup).toContain('Samantha Vance');
    });

    it('generates Minimal Single-Column Typst markup with compact black/white hierarchy', () => {
      const markup = generateTypstTemplate('minimal-single-column', sampleResume);
      expect(markup).toContain('DejaVu Sans');
      expect(markup).toContain('rgb("#000000")');
      expect(markup).toContain('Samantha Vance');
      expect(markup).toContain('Experience');
    });

    it('generates valid LaTeX document source for all templates', () => {
      const latex = generateLatexTemplate('modern-tech', sampleResume);
      expect(latex).toContain('\\documentclass');
      expect(latex).toContain('\\begin{document}');
      expect(latex).toContain('\\end{document}');
      expect(latex).toContain('Samantha Vance');
      expect(latex).toContain('HyperScale Cloud Labs');
    });
  });

  // 4. Compilation Performance & WebAssembly Verification
  describe('Binary PDF Compilation & Execution Speed (< 2.0s)', () => {
    beforeAll(async () => {
      // Warm up Typst WebAssembly compiler and font cache to prevent cold-start latency from failing the benchmark
      await typstCompilerService.compileToPdf(sampleResume, {
        template: 'modern-tech',
        targetPages: 1,
      }).catch(() => {});
    }, 30000);

    it('compiles structured resume to vector PDF in < 2.0 seconds via WebAssembly', async () => {
      const start = performance.now();
      const result = await typstCompilerService.compileToPdf(sampleResume, {
        template: 'modern-tech',
        targetPages: 1,
      });
      const duration = performance.now() - start;

      // Acceptance criterion: < 2.0s (typically < 100ms)
      expect(duration).toBeLessThan(2000);
      expect(result.durationMs).toBeLessThan(2000);
      expect(result.pdf).toBeInstanceOf(Buffer);
      expect(result.pdf.length).toBeGreaterThan(1000);
      // Valid PDF magic header
      expect(result.pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    });

    it('compiles all 3 templates successfully', async () => {
      const templates = ['classic-academic', 'modern-tech', 'minimal-single-column'] as const;

      for (const t of templates) {
        const res = await typstCompilerService.compileToPdf(sampleResume, {
          template: t,
          targetPages: 1,
        });
        expect(res.pdf).toBeInstanceOf(Buffer);
        expect(res.template).toBe(t);
        expect(res.pageCount).toBe(1);
      }
    });
  });

  // 5. ATS Parseability & Text Stream Selectability
  describe('ATS Parseability & Selectable Text Extraction', () => {
    it('generates 100% selectable and extractable text streams verifiable by pdf-parse', async () => {
      const result = await typstCompilerService.compileToPdf(sampleResume, {
        template: 'modern-tech',
      });

      const parser = new (PDFParse as any)({ data: new Uint8Array(result.pdf) });
      try {
        const parsed = await parser.getText();
        const fullText = parsed.pages
          ? parsed.pages.map((p: any) => p.text).join('\n')
          : parsed.text || '';

        // Verify ATS keywords and sections are present in stream order
        expect(fullText).toContain('Samantha Vance');
        expect(fullText).toContain('samantha.vance@techcorp.io');
        expect(fullText).toContain('Staff Infrastructure Architect');
        expect(fullText).toContain('HyperScale Cloud Labs');
        expect(fullText).toContain('WebAssembly');
        expect(fullText).toContain('Redis Sentinel');
        expect(fullText).toContain('WasmSandbox');
        expect(fullText).toContain('University of Washington');
      } finally {
        await parser.destroy().catch(() => {});
      }
    });
  });

  // 6. Strict Pagination & Dynamic Spacing Enforcement
  describe('Strict Pagination & Dynamic Vertical Spacing', () => {
    it('guarantees standard technical resume strictly fits on 1 page', async () => {
      const result = await typstCompilerService.compileToPdf(sampleResume, {
        targetPages: 1,
        strictPagination: true,
      });

      expect(result.pageCount).toBe(1);
    });

    it('dynamically adapts lengthy content to fit strictly on 1 page without orphan overflow', async () => {
      // Create a resume with heavy content (many extra bullets)
      const heavyResume: StructuredResume = {
        ...sampleResume,
        experience: [
          ...sampleResume.experience!,
          {
            role: 'Software Engineer II',
            company: 'NextGen Cloud Solutions',
            location: 'Portland, OR',
            startDate: '2017',
            endDate: '2019',
            bullets: [
              'Designed distributed caching layer utilizing Redis cluster, achieving sub-millisecond retrieval.',
              'Refactored legacy REST APIs into gRPC microservices, decreasing payload size by 60%.',
              'Integrated automated static code analysis into CI/CD pipelines catching 95% of regressions early.',
            ],
            technologies: ['TypeScript', 'Node.js', 'Redis', 'Docker'],
          },
        ],
      };

      const result = await typstCompilerService.compileToPdf(heavyResume, {
        targetPages: 1,
        strictPagination: true,
      });

      expect(result.pageCount).toBe(1);
    });

    it('allows 2-page pagination when targetPages is set to 2', async () => {
      const multiPageResume: StructuredResume = {
        ...sampleResume,
        experience: [
          ...sampleResume.experience!,
          {
            role: 'Lead Systems Engineer',
            company: 'Pinnacle Networks',
            startDate: '2016',
            endDate: '2019',
            bullets: [
              'Bullet 1 detailing major infrastructure overhaul across 5 global datacenters.',
              'Bullet 2 describing kernel-level tuning for network packet processing.',
              'Bullet 3 covering telemetry metrics collection using eBPF probes.',
              'Bullet 4 discussing disaster recovery and business continuity drills.',
            ],
          },
          {
            role: 'Infrastructure Developer',
            company: 'BaseCloud Systems',
            startDate: '2014',
            endDate: '2016',
            bullets: [
              'Bullet 1 on provisioning bare metal servers with custom PXE boot scripts.',
              'Bullet 2 on implementing zero-trust network access control policies.',
              'Bullet 3 on writing custom alerting plugins for monitoring clusters.',
            ],
          },
        ],
      };

      const result = await typstCompilerService.compileToPdf(multiPageResume, {
        targetPages: 2,
        strictPagination: true,
        fontSizePt: 10.0,
      });

      expect(result.pageCount).toBeLessThanOrEqual(2);
    });
  });

  // 7. Profile Mapping Utility
  describe('Profile Mapping Utility', () => {
    it('correctly maps raw resume profile data into StructuredResume format', () => {
      const mockProfile = {
        name: 'Jordan Lee',
        targetRole: 'Site Reliability Engineer',
        summary: 'Experienced SRE with passion for reliability and automation.',
        selectedSkills: ['Kubernetes', 'Prometheus', 'Golang', 'Ansible'],
        selectedProjects: [
          {
            name: 'AutoScaler',
            description: 'Custom Kubernetes HPA controller based on queue length.',
            bullets: ['Implemented custom metrics server in Go.'],
            technologies: ['Go', 'Kube-SDK'],
          },
        ],
      };

      const mapped = typstCompilerService.mapProfileToStructuredResume(mockProfile);
      expect(mapped.header.name).toBe('Jordan Lee');
      expect(mapped.header.title).toBe('Site Reliability Engineer');
      expect(mapped.summary).toBe('Experienced SRE with passion for reliability and automation.');
      expect(mapped.skills).toHaveLength(1);
      expect(mapped.projects).toHaveLength(1);
      expect(mapped.projects![0].name).toBe('AutoScaler');
    });
  });

  // 8. Render Worker Integration
  describe('worker-render Integration', () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devtrack-render-test-'));
    });

    afterAll(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    it('processes resume render job and exports PDF to filesystem', async () => {
      const exportPath = path.join(tmpDir, 'resume-output.pdf');
      const mockJob: any = {
        id: 'job-test-123',
        data: {
          userId: 'user-789',
          resumeData: sampleResume,
          options: {
            template: 'modern-tech',
            targetPages: 1,
          },
          exportPath,
        },
      };

      const jobResult = await processResumeRenderJob(mockJob);
      expect(jobResult.success).toBe(true);
      expect(jobResult.pageCount).toBe(1);
      expect(jobResult.durationMs).toBeLessThan(2000);
      expect(jobResult.exportPath).toBe(exportPath);

      // Verify file exists on disk and is a valid PDF
      const fileStat = await fs.stat(exportPath);
      expect(fileStat.size).toBeGreaterThan(1000);
      const fileHeader = await fs.readFile(exportPath);
      expect(fileHeader.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    });
  });
});
