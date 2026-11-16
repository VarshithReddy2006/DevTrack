# @devtrack/sm2

Zero runtime dependency TypeScript scheduling engine for DevTrack issue #309.

```ts
import { createInitialSm2State, nextState } from '@devtrack/sm2';

const card = createInitialSm2State(new Date('2026-01-01T12:00:00Z'));
const reviewed = nextState(card, 'easy', card.dueAt);
```

Run from the repository root:

```sh
npm ci
npm run test -w @devtrack/sm2
npm run build -w @devtrack/sm2
```

The package exports ESM JavaScript and TypeScript declarations after building.
It has no Node-specific runtime APIs and can be bundled for browsers.

## Scheduling policy

The EF update is based on the [official SuperMemo-2 description](https://super-memory.org/archive/english/ol/sm2.htm).
DevTrack's issue specifies a variant: initial successful intervals are **1, 3,
7 days**, rather than the original algorithm's 1 and 6 days. `failed`, `hard`,
and `easy` map to quality 1, 3, and 5. Failure resets repetitions to zero and
schedules tomorrow. EF changes on every review and never falls below 1.3.

This package preserves the policy introduced in PR #323: calculate the updated
EF first, round it to two decimal places, then use that EF to multiply the prior
interval after the three seed intervals. Thus eight easy reviews produce
intervals `1, 3, 7, 20, 60, 186, 595, 1964`. The golden tables test this DevTrack
variant; they are not claimed to be published official SuperMemo test vectors.

Pass `now` explicitly for deterministic results. A day is exactly 86,400,000 ms,
including across DST, leap-day and year boundaries. Returned dates are independent
copies; neither the current state nor the supplied date is modified.

`nextState` rejects invalid ratings, non-finite/below-floor EF, negative or
fractional intervals/repetition counts, repetition counter overflow, invalid
review dates, and schedules outside JavaScript's Date range with `RangeError`.
An interval of zero is accepted for an unscheduled initial card. Stored `dueAt`
and `lastReviewedAt` do not affect the transition: the supplied review time is
authoritative, allowing early and late reviews.
