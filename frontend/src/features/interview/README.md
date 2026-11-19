# Interview rubric dashboard

`components/InterviewRubricCard.tsx` presents the persisted `interview-rubric-v1`
report from the detailed evaluator, with its four scores, rationale, verbatim
candidate citations (one-based turn numbers and answer/code source), strengths,
improvements, and model-answer drawer. The overall score must equal the rounded,
equally weighted mean of the dimensions. The frontend schema rejects invalid or
inconsistent reports instead of displaying misleading scores.

```tsx
const report = interviewRubricReportSchema.parse(response.data);
<InterviewRubricCard key={`${userId}:${reportId}`} report={report} />
```

The schema mirrors `backend/src/modules/interview/rubricEvaluator.service.ts`.
Citation authenticity remains the server evaluator's responsibility; the component
does not have the original transcript to revalidate quotes. Strengths and critique
are displayed as supplied; supporting quotes remain attached to the dimensions
specified by the server rather than inventing links between individual comments
and citations.

The backend provides no hiring recommendation. This UI derives a **practice** badge
from the validated overall score: Strong Hire at 85+, Hire at 70–84, otherwise
Lean No Hire. These UI thresholds are displayed explicitly and are not employer
decisions. Backend `basic_mode` reports represent unavailable assessment, so they
show “Not evaluated” without bars, a hiring badge, or a model-answer button.

The shared Drawer supplies modal labeling, focus trapping, Escape dismissal,
scroll locking and opener focus restoration. Reference prose is escaped plain
text. Explicit fenced JavaScript/TypeScript, Python, Java and C++ blocks use
highlight.js; unknown languages remain escaped code. Neither prose HTML nor code
is executed. Unfenced answers stay readable plain text, without guessed language
or invented code. The drawer shows the server's optimal approach/complexity text.

## Production integration boundary

This change delivers reusable components, not a new report-read API. Current main
has no authenticated HTTP endpoint for persisted detailed rubric reports (see
`backend/src/modules/interview/README.md`). The existing interview review page
consumes a different legacy scorecard contract and stays on that contract. Mapping
its architecture/edge-case dimensions to code quality or complexity would invent
assessment data. The owning report API must authorize access and return the actual
persisted report before the review page can mount this component. Use the existing
Axios/query/SSE infrastructure, and remount on owner/report changes with a stable
owner/report key. No mock production route or fabricated model answer is supplied.

## Validation

Run from `frontend/`:

```sh
npm run test:unit -- src/features/interview/__tests__/InterviewRubricCard.test.tsx src/pages/interview/InterviewStudioPage.test.tsx
npm run build
```

Tests cover recommendation boundaries, dimension values and mean validation,
citations, fallback and invalid reports, feedback, syntax highlighting/escaping,
drawer keyboard and close behavior, focus restoration and updated props.
