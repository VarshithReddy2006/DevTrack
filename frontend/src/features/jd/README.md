# Skill gap matrix

`components/SkillGapMatrix.tsx` is the reusable report component for #451. It shows
matched and missing skills in two columns on desktop and one on mobile, grouped
into Languages, Frameworks, Cloud & DevOps, System Design and Databases. Unknown
categories remain visible under Other. `SkillCategoryPill` renders the category label.

```tsx
import { SkillGapMatrix } from './components/SkillGapMatrix';

<SkillGapMatrix
  jobTargetId={target.id}
  skills={comparedSkills}
  onAddToStudyPlan={async ({ jobTargetId, skill }) => {
    await studyPlanMutation.mutateAsync({ jobTargetId, skill });
    // Invalidate the owning report/study-plan query after persistence succeeds.
  }}
/>
```

The caller supplies validated `ComparedSkill[]` from `skillGap.types.ts`:

- Every skill has a unique, stable `id`, a name, the source category and a
  `requirement` of `required`, `preferred` or `unknown`. Unknown priority is shown as
  “Priority not provided”; the component never promotes a preferred/unknown skill
  into a mandatory requirement. Common category labels are normalized; arbitrary
  labels fall back to Other rather than inferring a category from the skill name.
- Matched skills have `status: 'matched'` and an explicit evidence array containing
  `resume`, `github` or `dsa` sources with a boolean `verified` value. A matched
  keyword is not proof. Only explicitly verified source evidence displays the shared
  Verified badge, with each source's own verification state written out. The matrix
  does not perform verification itself or invent proof links. Badge interaction is
  disabled because this view model does not carry a cryptographic proof document.
- Missing skills have `status: 'missing'` and may carry `inStudyPlan: true` to disable
  an already completed action. The action callback receives the target id and a copy
  of the original missing-skill payload, including its stable id, category and priority.

Search filters names and displayed categories immediately, case-insensitively with
Unicode compatibility normalization. Category order is fixed; source skill order
within each category is preserved. Filtering does not discard pending action state.
Empty data, no matches and empty sides have explicit messages, without fabricated
skills or success claims. Labels, headings, native buttons, focus rings, status and
error announcements supplement the matched/missing colors.

## Action contract

`onAddToStudyPlan` is required and returns a promise. Resolve only after the owning
API confirms persistence, and reject on failure. The component shows pending state,
blocks duplicate requests for the same skill (including while filtered out), and
allows retries after a rejected or synchronous exception. Independent skills remain
actionable. A successful callback is acknowledged as Added; the component makes no
network calls and does not mutate its input props.

Changing `jobTargetId` resets search, pending UI, errors and success acknowledgements.
A late result from the old instance cannot change the new target's state. The owning
page must unmount/remount this component when changing authenticated users or replacing
an entire comparison revision; a React `key` containing the owner/report revision is
appropriate. Skill ids must identify the same skill across ordinary refreshes.
Successful actions are cached for that mounted report. A fresh report instance should
use authoritative `inStudyPlan` values if a plan was changed elsewhere.

## Production integration boundary

The current job-target detail DTO contains match percentages, missing keywords,
generic gaps and rewrites. It does not expose the per-skill matched provenance,
verification state and Required/Preferred priority this component needs. The frontend
also has no compatible gap-to-study-plan creation mutation to bind here. This change
does not invent those fields, infer verification from a score, or submit a different
roadmap-generation operation as if it created one skill milestone.

The owning job-target/readiness integration must map real matched/missing requirements
into this view model and supply an authenticated, idempotent persistence callback.
Mount the component when those are available. The existing report page and its keyword
copy/rewrite interactions remain intact; no mock report, new route or no-op mutation
is exposed in the production UI. This PR delivers the requested component and callback
contract, not a live end-to-end study-plan creation flow.

## Validation

Run `npm run test:unit -- src/features/jd/__tests__/SkillGapMatrix.test.tsx` from
`frontend/`. Coverage includes grouping, all priorities, explicit verification/source
labels, filtering, empty states, immutable props, async actions, retry, duplicate
suppression and target changes. Existing verification-badge and job-target workspace
suites cover regressions in shared UI and the report page.

Chromium checks use an isolated local fixture, not a production demo route. They cover
desktop two-column layout, mobile stacking, long names, light/dark appearance, no
horizontal overflow at 375px and at 320px with 200% root text scaling, keyboard search
and Tab/Enter/Space activation, and pending/failure/retry/success states. The text
scaling check is not a claim of testing every browser's native zoom mode. Live API,
authentication and persistent study-plan behavior remain unverified until the owning
data/mutation adapters are available.
