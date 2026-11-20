# Feature flags

The API uses the standard `success`, `data`, `message`, and `timestamp` response fields.

- `GET /api/v1/flags` returns the enabled flag keys for the authenticated user.
- `GET /api/v1/ops/flags` returns stored flag definitions and versions. The admin role is required.
- `PATCH /api/v1/ops/flags/:key` partially updates a flag and increments its version. It creates a flag if the key is new. New flags default to disabled with zero rollout and an empty allowlist. The key is the default name.

The PATCH body accepts `name`, `description`, `enabled`, `rolloutPercent` (an integer from 0 to 100), and `allowedUserIds` (MongoDB user IDs). Supplying an allowlist replaces the current one. An enabled flag grants access to allowlisted users, then assigns everyone else a deterministic rollout bucket. Setting `enabled` to false disables access for all users.

## Audit log

Each admin PATCH that changes at least one setting (or creates the flag) writes a `FeatureFlagAudit` entry: the flag key, the version the update produced, the admin's user ID and username, and a `changes` list of `{ field, from, to }`. The previous values come from the same atomic update, so concurrent admins each get an exact history. Updates that change nothing are not recorded. If the audit write fails, the flag change still stands and the failure is logged as an error.

- `GET /api/v1/ops/flags/audit` returns the newest entries first. The admin role is required. Query parameters: `limit` (1 to 100, default 50) and `key` to show one flag.

Mount `requireFlag(key)` after authentication and before the protected controller. A disabled or unknown flag returns HTTP 404 with code `FEATURE_DISABLED`.

Redis caches the flag catalog and per-user decisions for 60 seconds. A successful admin update immediately switches readers to a fresh catalog generation and a new flag version. Deployments without Redis read MongoDB directly. If configured Redis is disconnected, reads fall back to MongoDB and admin writes return HTTP 503. If Redis loses connectivity after a write, the response reports whether the database write completed. Readers may continue to see a previous cached value until the catalog expires if invalidation could not be confirmed.
