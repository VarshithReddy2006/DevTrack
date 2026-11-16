# @devtrack/ats-core

This workspace builds to ESM with TypeScript declarations and has no runtime dependencies. Run `npm ci` from the repository root, then `npm run test -w @devtrack/ats-core` to build the package and compare Node and a browser-targeted bundle with the legacy fixtures.

The backend and browser can pass the same text and keywords to `validateParserSafety`, `validateFormatting`, `checkKeywordCoverage`, and `validateSections`. Pass the resulting warnings and section checks to `calculateExtractionConfidence`, then supply the findings and confidence to `calculateAtsScore`. Pass the same target role and credibility penalty to reproduce a calibrated backend score. The backend supplies those values from the stored profile and evidence claims.

`splitBullets` extracts marked or numbered bullets. `analyzeQuantifiedImpact` and `analyzeActionVerbs` return one boolean per input bullet. These diagnostics are available independently of the legacy score.

The golden fixtures record the deterministic findings, recommendations, score, and word count from `ATSCompatibilityEngine` at commit `a2f42b5`.

## Job description matching

Use the versioned skill taxonomy to get a reproducible report without an AI provider.

    import { extractRequirements, matchScore } from '@devtrack/ats-core';

    const requirements = extractRequirements('Requirements: 3+ years with PostgreSQL. Nice to have: Redis.');
    const report = matchScore(requirements, [{ skill: 'Postgres', years: 3 }], [
      { skill: 'PostgreSQL', verified: true },
    ]);

The report carries the taxonomy version and the source label taxonomy_only. Hard requirements, stack coverage, verified evidence and experience carry weights of 40, 30, 20 and 10. Dimensions without applicable job criteria return null, and the score redistributes their weight across applicable dimensions. Pass overall years of experience as the fourth argument for job requirements that do not name a skill.

Extraction uses a fixed alias list and heading and phrase rules. It can miss unfamiliar terms or misread ambiguous, negated or alternative requirements. Evidence verification comes from the caller.
