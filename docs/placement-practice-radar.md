# Placement practice radar

GET /api/readiness/placement-radar uses the existing authenticated owner and returns private/no-store data. It reads existing intelligence; it does not call an LLM, provider sync, or any paid service. The overview now mounts the existing accessible radar instead of leaving it unused.

Five axes: explicit mapped DSA structure/algorithm tags; verified project architecture proxy; explicit Core CS topics if present; behavioral evidence remains unknown because the existing coding interview rubric is not a behavioral assessment. No coding/communication score is misrepresented as a STAR interview grade. Missing, stale (>7 days), future, nonfinite and unverified evidence is excluded. Duplicate topic names use their latest observation. Per-axis scores are equal means of valid mapped topic mastery. Contest ratings (180-day existing source window), seven-day revision retention and solve consistency are displayed separately: combining unrelated platform rating scales into a fabricated five-axis grade would be misleading.

The weakest/unknown three axes generate deterministic two-pass practice tasks plus day-seven review, 30 minutes per day. Goals 50/65/80 are explicit illustrative practice goals, not employer cutoffs or percentile benchmarks. Unknown axes have explicit table status and no asserted zero grade. Text export preserves evidence, caveats, model version and plan. Browser print offers Save PDF through the browser. No account data is sent to a third-party export service.

The current schema does not contain verified behavioral/Core CS assessment coverage for every user. Those gaps are shown rather than fabricated. This feature is a preparation aid and cannot predict placement outcomes.

Validation: 27 backend tests (including authenticated HTTP/real disposable Mongo owner isolation), 10 frontend tests, both production builds and focused ESLint passed. Browser fixture verified goal switching and downloaded a report with all evidence and seven days. No hosted Clerk/provider/LLM was used.
