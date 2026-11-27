# Contest Web Push

The existing maintenance sweep detects contests starting in 29–31 minutes. Its
contest consumer now sends encrypted Web Push notifications for newly created
contest alerts, alongside the existing in-app notification and SSE paths.

## Configuration

Install backend dependencies with npm. Generate a persistent key pair with
`npx web-push generate-vapid-keys --json` and configure `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (`mailto:` contact or HTTPS URL) on both
the API and maintenance worker. Keep the private key secret. Missing or mismatched
keys disable push delivery and return 503 from key/subscription registration;
in-app alerts continue working.

## Authenticated API

Routes are mounted under `/api/v2/notifications` (also the existing v1 and legacy
API aliases):

- `GET /push-key` returns `{ "publicKey": "..." }`, with no private credentials.
- `POST /subscribe` accepts browser `PushSubscription.toJSON()` output:
  `{ endpoint, expirationTime?, keys: { p256dh, auth }, vapidPublicKey? }`.
  Clients should include the public key used for `pushManager.subscribe` as
  `vapidPublicKey`, so stale registrations during rotation return 409. When the
  field is omitted, registration binds to the current configured public key.
  Successful registration returns 201 and `{ "success": true }`.
- `POST /unsubscribe` accepts `{ "endpoint": "..." }`, removes only the current
  user's subscription, and returns 200 even if already absent. It also works
  while push credentials are disabled.
- `PATCH /api/v1/notifications/preferences` with `{ "enablePush": true }`
  explicitly opts into delivery.
  Subscription registration does not change notification preferences.

The server takes user identity from authentication and never returns stored
subscription credentials. A unique endpoint cannot be claimed by another account
(409). On shared devices, unsubscribe on the server before signing out, then
unsubscribe the browser subscription before signing in as another account.
Re-registering an owned endpoint refreshes its encryption credentials.

Only HTTPS push-service endpoints at `fcm.googleapis.com`,
`updates.push.services.mozilla.com`, `web.push.apple.com`, or a single subdomain
of `notify.windows.com` are accepted. Userinfo, custom ports, fragments, arbitrary
hosts, invalid P-256 keys, invalid auth secrets, and expired subscriptions are
rejected. New providers require an explicit allowlist update.

## Delivery and rotation

Users must also have `UserSettings.notifications.contestAlerts` enabled, keep
`UserSettings.notifications.pushNotifications` enabled, and match the existing
platform preference filter. Delivery targets only their registered
subscriptions. The AES128GCM payload includes contest name, platform favicon,
start time, remaining minutes, an HTTPS contest URL, and an open-contest action.
The existing service worker renders its icon/action and opens the contest link.
TTL is limited to the smaller of 30 minutes and time until the contest starts;
already-started contests are skipped. Each provider request times out after 10s.

HTTP 404 and 410 remove only the failed subscription credentials; an in-flight
response cannot delete a concurrently refreshed subscription. Other failures
retain the record and are logged without the endpoint, keys, or provider body.
One failed provider request does not stop subsequent subscriptions.

For key rotation, move the old pair into `VAPID_PREVIOUS_PUBLIC_KEY` and
`VAPID_PREVIOUS_PRIVATE_KEY`, then set the new active pair on the API and worker.
Existing records retain their old public-key binding and continue using the old
private key. Clients should unsubscribe their old browser subscription, obtain
the new key, subscribe again, and register the new subscription. Remove the old
pair after clients have migrated. Only one previous pair is supported; unknown
bindings are skipped, never sent with the wrong key.

## Limits and verification

Delivery is best effort and sequential within the existing sweep. There is no
new durable retry queue or guarantee of exactly-once delivery. The existing
scheduler marks a contest as emitted before handling it; transient push failures
are not retried for that contest. In-app insertion guards normal consumer replays.
Large recipient lists can extend sweep duration. Opted-in users are streamed
from a cursor in batches of 100, so the consumer never loads the whole list.

Each contest event is claimed once before any alert goes out: Redis
`SET NX EX` when Redis is ready, otherwise a `ProcessedEvent` row (unique per
consumer and event id) when Redis is unconfigured, not ready or erroring. The
claim is a 10 minute lease while users are notified and becomes a 24 hour marker
when the run finishes. A run that throws releases its claim so a retry is not
skipped; a worker that dies mid-run leaves a lease that expires on its own. The
per-user notification id still stops a second alert in either case.

Browser permission, subscription enrollment UI, and a deployed push-provider
smoke test are outside this backend change; the existing service worker supports
receiving the resulting messages.

Run `npx vitest run src/__tests__/modules/notifications/pushNotification.test.ts`
and `npm run build` from `backend/`. The claim, fallback and cursor cases are in
`src/__tests__/modules/notifications/contest-alerts.dedup.test.ts`, which fakes
Redis and the models. The other tests use an owned temporary MongoDB instance
and mock outbound provider requests. A cryptographic test uses the real library
to verify the VAPID JWT signature and decrypt the generated payload with the
browser's private key. HTTP tests stub authentication; they do not verify Clerk
or delivery through a real browser/provider.
