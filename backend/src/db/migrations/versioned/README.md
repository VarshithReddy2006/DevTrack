# Versioned database migrations

Add an ESM file named `YYYYMMDDHHmmss-description.mjs` with a default export containing
`name` (the filename without its extension), `async up({ db, session })`, and
`async down({ db, session })`. Pass `{ session }` to each MongoDB operation and await
operations sequentially. Both directions can be retried by MongoDB as part of a
transaction, so keep them limited to database operations. Keep the migration logic
in the versioned file and avoid side effects during module import. Once applied,
keep the original file and add a new migration for further changes.
Choose a version that sorts after the latest migration applied to the target database.

The existing daily challenge and index maintenance scripts still run through their
original entry points. See [Deployment](../../../../../DEPLOYMENT.md) for CLI usage
and recovery.
