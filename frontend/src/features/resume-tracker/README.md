# Resume tracker

## Live bullet editor

`/resume/editor` is an authenticated, lazy-loaded route enabled by the existing
`ats-live-editor` feature flag. The Resume Intelligence page links to it only
when the account has that flag. Flag lookup failures keep the route closed.

Choose the profile summary or a saved variant. A variant's existing `bulletEdits`
are loaded when available; legacy variants without edited text start from the
profile summary. The editor does not invent experience or project bullets from
project IDs. Add one bullet per line and use `# Experience`, `# Skills`, etc. for
section headings. The API limits apply: 200 bullets, 1,000 characters per bullet
and 50 characters per section. Invalid or oversized content is reported rather
than truncated.

CodeMirror supports undo/redo, line wrapping, highlighted action verbs and
numbers. Word comparisons show saved and edited text side by side. ATS previews
run locally after 300 ms without a scoring request. The preview and backend both
use the shared `@devtrack/ats-core` bullet adapter. Source previews use the
profile's target role and the selected variant's prioritized keywords (or profile
skills). Action verbs, quantified impact and concise-bullet counts are writing
checks, not extra weights added to the existing ATS algorithm.

Save as Variant uses the existing `POST /resume-intelligence/variants` contract.
The server generates role-specific keywords, recomputes the score and owns the
timestamp. Choosing a different role can therefore change the saved score.
The UI checks the echoed edited text before resetting dirty state. Network,
validation and disabled-flag responses preserve the draft. Editing/source changes
are disabled while saving so a late response cannot clear newer input. Drafts
remain in memory, not browser storage.

The shared router guard protects shell links, editor links and native Back/Forward;
refresh/close uses the browser's before-unload warning. Cancelling keeps the draft.
The native save dialog supports Escape, focus trapping and return to its trigger.
Account changes unmount the workspace keyed by the authenticated user.

## Validation

Use the repository's Node 22/24 setup and install normally:

```sh
npm ci --prefix frontend
npm run lint --prefix frontend
npm run build --prefix frontend
npm test --prefix frontend
npm ci --workspace @devtrack/ats-core
npm test --workspace @devtrack/ats-core
```

The production build checks the Vite manifest: workspace, CodeMirror and diff
must stay dynamic imports. All incremental JS/CSS in that dependency closure,
excluding the already loaded application shell, must total less than 250 KiB
gzip. The build fails on missing chunks, eager loading or excess size.

With a disposable local Redis on port 6379, run:

```sh
npm run test:e2e:resume --prefix frontend
```

The browser fixture creates its own MongoDB replica set for transactional saves.
It retains the existing upload/error flows and adds real API save/reload and score
parity, no typing-time API requests, pending-save locking, cancelled link/Back/
refresh navigation, mobile layout, dialog keyboard focus and failed-save recovery.
Only the fixture supplies a fixed identity; production authentication is unchanged.
Browser screenshots are written to `frontend/test-results/` for review.
