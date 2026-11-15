# @devtrack/ats-core

This workspace builds to ESM with TypeScript declarations and has no runtime dependencies. Run `npm ci` from the repository root, then `npm run test -w @devtrack/ats-core` to build the package and compare Node and a browser-targeted bundle with the legacy fixtures.

The backend and browser can pass the same text and keywords to `validateParserSafety`, `validateFormatting`, `checkKeywordCoverage`, and `validateSections`. Pass the resulting warnings and section checks to `calculateExtractionConfidence`, then supply the findings and confidence to `calculateAtsScore`. Pass the same target role and credibility penalty to reproduce a calibrated backend score. The backend supplies those values from the stored profile and evidence claims.

`splitBullets` extracts marked or numbered bullets. `analyzeQuantifiedImpact` and `analyzeActionVerbs` return one boolean per input bullet. These diagnostics are available independently of the legacy score.

The golden fixtures record the deterministic findings, recommendations, score, and word count from `ATSCompatibilityEngine` at commit `a2f42b5`.
