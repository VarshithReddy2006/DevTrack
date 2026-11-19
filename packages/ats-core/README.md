# @devtrack/ats-core

This workspace builds to ESM with TypeScript declarations and has no runtime dependencies. Run `npm ci` from the repository root, then `npm run test -w @devtrack/ats-core` to build the package and compare Node and a browser-targeted bundle with the legacy fixtures.

The backend and browser can pass the same text and keywords to `validateParserSafety`, `validateFormatting`, `checkKeywordCoverage`, and `validateSections`. Pass the resulting warnings and section checks to `calculateExtractionConfidence`, then supply the findings and confidence to `calculateAtsScore`. Pass the same target role and credibility penalty to reproduce a calibrated backend score. The backend supplies those values from the stored profile and evidence claims.

`splitBullets` extracts marked or numbered bullets. `analyzeQuantifiedImpact` and `analyzeActionVerbs` return one boolean per input bullet. These diagnostics are available independently of the legacy score.

The golden fixtures record the deterministic findings, recommendations, score, and word count from `ATSCompatibilityEngine` at commit `a2f42b5`.

## Bullet score differential

`scoreDifferential({ originalBullets, revisedBullets, targetKeywords })` returns
integer `originalScore`, `revisedScore`, `delta` (revised minus original),
`keywordChanges: { added, removed }`, revised `brevityScore`, and
`originalBrevityScore`. All scores are 0–100. The function is pure, does not mutate
input, and works identically in Node and browser bundles.

This is a bullet-only preview, not a persisted full-resume score. It uses the
existing parser, formatting, literal keyword coverage, extraction-confidence, and
ATS aggregation functions with no inferred resume sections or supplied role.
Keywords are trimmed and deduplicated case-insensitively, preserving the first
label/order; symbol keywords such as C++, C#, and .NET use the shared word-boundary
matching. Empty/whitespace-only bullet lists score zero. With no target keywords,
keyword coverage is neutral.

Brevity starts at 100 per nonempty bullet. Fewer than 8 words lose 10 points per
missing word; more than 35 lose 2 points per excess word, capped at 70 per bullet.
The phrases `responsible for`, `worked on`, `helped to`, `in order to`, `very`,
`really`, `various`, `numerous`, and `successfully` lose 10 points per occurrence,
capped at 30 per bullet. The mean of those bullet scores is rounded to an integer.
The preview deducts 20% of the lost brevity points and an additional 5 points per
target-keyword occurrence after its third occurrence across the entire bullet
list, capped at 30 total stuffing points, through the shared credibility-penalty
input. The shared aggregator rounds/clamps the final result.

These explicit heuristics are advisory and not a recruiter outcome prediction;
legitimate repeated skills can incur a stuffing penalty. The API bounds its
inputs; direct package callers should impose equivalent limits for interactive
latency. This utility does not change existing saved-resume scoring behavior.

## Job description matching

Use the versioned skill taxonomy to get a reproducible report without an AI provider.

    import { extractRequirements, matchScore } from '@devtrack/ats-core';

    const requirements = extractRequirements('Requirements: 3+ years with PostgreSQL. Nice to have: Redis.');
    const report = matchScore(requirements, [{ skill: 'Postgres', years: 3 }], [
      { skill: 'PostgreSQL', verified: true },
    ]);

The report carries the taxonomy version and the source label taxonomy_only. Hard requirements, stack coverage, verified evidence and experience carry weights of 40, 30, 20 and 10. Dimensions without applicable job criteria return null, and the score redistributes their weight across applicable dimensions. Pass overall years of experience as the fourth argument for job requirements that do not name a skill.

Extraction uses a fixed alias list and heading and phrase rules. It can miss unfamiliar terms or misread ambiguous, negated or alternative requirements. Evidence verification comes from the caller.

## Weighted requirement matching

`weightedMatcher(requirements, candidateSkills, { weights? })` is a separate pure
matching API. Supply requirements as `{ skill, tier? }` and candidate skills as
strings. Tiers are `mandatory`, `preferred`, and `soft`, weighted 60/25/15 by
default. Each tier uses equal coverage per unique skill. The result contains
`score`, `tiers` (each with `score`, `matched`, `missing`), `matchedSkills`, and
`missingCriticalRequirements`. Scores are percentages rounded to two decimals.
Any missing mandatory requirement caps the composite at 75, including when its
custom weight is zero. Empty tiers have null scores and their weights are
redistributed; no requirements or no applicable positive weights scores zero.

    import { weightedMatcher } from '@devtrack/ats-core';

    const report = weightedMatcher([
      { skill: 'PostgreSQL', tier: 'mandatory' },
      { skill: 'Docker', tier: 'preferred' },
      { skill: 'Leadership', tier: 'soft' },
    ], ['postgres', 'Docker']); // 85; leadership is missing

Explicit tiers should reflect the job's requirements. Without a tier, `skillTier`
uses the existing taxonomy: languages, databases and architecture default to
mandatory; Agile, Scrum, code review, mentorship, leadership, communication and
teamwork default to soft; other terms default to preferred. This is a fallback
heuristic, not an inference that every language in a job is mandatory. Parsed
`extractRequirements` skills can be mapped by the caller from their contexts to
explicit tiers. Unknown terms remain matchable after Unicode, whitespace and case
normalization. Existing taxonomy aliases resolve to canonical names. Matching is
by complete skill name, not free-text substring or semantic similarity.

Duplicate aliases count once in the strictest supplied tier (mandatory, then
preferred, then soft). Output lists are sorted within each tier, independent of
input order. Custom weights partially override defaults, accept finite
nonnegative values, and are normalized over applicable tiers. All-zero, negative,
nonfinite or explicitly undefined weights and unknown runtime tiers are rejected.
Inputs and exported defaults are not mutated. This API has no I/O and works in
Node and browser bundles. It does not replace the existing four-dimension
`matchScore`, wire a backend endpoint, verify evidence, or evaluate years of
experience; those remain separate caller responsibilities.
