import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { getUserMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
}));

vi.mock('@clerk/express', () => ({
  clerkClient: {
    users: {
      getUser: getUserMock,
    },
  },
}));

import { User, UserProfile, UserSettings } from '../../../db/models/index.js';
import { logger } from '../../../shared/logger.js';
import { syncClerkUser } from '../../../services/auth/ClerkUserSyncService.js';

function makeDuplicateKeyError(keyPattern: Record<string, 1>): Error & {
  code: number;
  keyPattern: Record<string, 1>;
  keyValue: Record<string, unknown>;
} {
  const field = Object.keys(keyPattern)[0] ?? 'unknown';
  return Object.assign(
    new Error(`E11000 duplicate key error collection: test.users index: ${field}_1 dup key`),
    {
      name: 'MongoServerError',
      code: 11000,
      keyPattern,
      keyValue: { [field]: 'duplicate_value' },
    },
  );
}

describe('ClerkUserSyncService (syncClerkUser)', () => {
  beforeAll(async () => {
    await Promise.all([User.init(), UserSettings.init(), UserProfile.init()]);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    getUserMock.mockReset();
  });

  it('rejects empty or whitespace clerkUserId before querying database or Clerk', async () => {
    const findSpy = vi.spyOn(User, 'findOne');

    await expect(syncClerkUser('   ')).rejects.toMatchObject({
      code: 'INVALID_CLERK_USER_ID',
      statusCode: 400,
    });

    expect(findSpy).not.toHaveBeenCalled();
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it('1. rejects missing emailAddresses without querying User by undefined email or creating records', async () => {
    const findSpy = vi.spyOn(User, 'findOne');
    const createSpy = vi.spyOn(User, 'create');
    const warnSpy = vi.spyOn(logger, 'warn');

    getUserMock.mockResolvedValue({
      id: 'clerk_no_email',
      username: 'validuser',
      firstName: 'Ada',
      lastName: 'Lovelace',
      emailAddresses: undefined,
    });

    await expect(syncClerkUser('clerk_no_email')).rejects.toMatchObject({
      code: 'EMAIL_REQUIRED',
      statusCode: 400,
    });

    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(findSpy).toHaveBeenCalledWith({ clerkId: 'clerk_no_email' });
    expect(createSpy).not.toHaveBeenCalled();
    expect(await User.countDocuments()).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ clerkUserId: 'clerk_no_email', code: 'EMAIL_REQUIRED' }),
    );
  });

  it('2. rejects empty and whitespace-only email addresses cleanly without creating DB records', async () => {
    const findSpy = vi.spyOn(User, 'findOne');

    getUserMock.mockResolvedValueOnce({
      id: 'clerk_empty_array',
      emailAddresses: [],
    });

    await expect(syncClerkUser('clerk_empty_array')).rejects.toMatchObject({
      code: 'EMAIL_REQUIRED',
      statusCode: 400,
    });

    getUserMock.mockResolvedValueOnce({
      id: 'clerk_blank_email',
      emailAddresses: [{ id: 'em_1', emailAddress: '   \t\n  ', verification: { status: 'verified' } }],
    });

    await expect(syncClerkUser('clerk_blank_email')).rejects.toMatchObject({
      code: 'EMAIL_REQUIRED',
      statusCode: 400,
    });

    expect(findSpy).not.toHaveBeenCalledWith(expect.objectContaining({ email: expect.anything() }));
    expect(await User.countDocuments()).toBe(0);
  });

  it('3. rejects malformed emails and does not leak raw email PII in errors or logger output', async () => {
    const malformedInputs = ['not-an-email', '@example.com', 'user@', 'user@localhost', 'a b@example.com'];
    const infoSpy = vi.spyOn(logger, 'info');
    const warnSpy = vi.spyOn(logger, 'warn');
    const errorSpy = vi.spyOn(logger, 'error');

    for (const [idx, badEmail] of malformedInputs.entries()) {
      const clerkId = `clerk_bad_${idx}`;
      getUserMock.mockResolvedValueOnce({
        id: clerkId,
        emailAddresses: [{ id: 'em_bad', emailAddress: badEmail, verification: { status: 'verified' } }],
      });

      let caught: unknown;
      try {
        await syncClerkUser(clerkId);
      } catch (err) {
        caught = err;
      }

      expect(caught).toMatchObject({
        code: 'INVALID_EMAIL',
        statusCode: 400,
      });
      expect((caught as Error).message).not.toContain(badEmail);
    }

    const serializedLogs = JSON.stringify([
      ...infoSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls,
    ]);
    for (const badEmail of malformedInputs) {
      expect(serializedLogs).not.toContain(badEmail);
    }
    expect(await User.countDocuments()).toBe(0);
  });

  it('selects primaryEmailAddressId over secondary verified addresses when both are valid', async () => {
    getUserMock.mockResolvedValue({
      id: 'clerk_primary_select',
      primaryEmailAddressId: 'em_primary',
      emailAddresses: [
        { id: 'em_secondary', emailAddress: 'secondary@example.com', verification: { status: 'verified' } },
        { id: 'em_primary', emailAddress: 'Primary@Example.COM', verification: { status: 'verified' } },
      ],
      username: 'primary_user',
      firstName: 'Primary',
      lastName: 'User',
    });

    const user = await syncClerkUser('clerk_primary_select');
    expect(user.email).toBe('primary@example.com');
    expect(user.isEmailVerified).toBe(true);
  });

  it('prioritizes verified secondary email over unverified primary email', async () => {
    getUserMock.mockResolvedValue({
      id: 'clerk_pref_verified_secondary',
      primaryEmailAddressId: 'em_unverified_primary',
      emailAddresses: [
        { id: 'em_unverified_primary', emailAddress: 'unverified.primary@example.com', verification: { status: 'unverified' } },
        { id: 'em_verified_secondary', emailAddress: 'verified.secondary@example.com', verification: { status: 'verified' } },
      ],
      username: 'pref_user',
    });

    const user = await syncClerkUser('clerk_pref_verified_secondary');
    expect(user.email).toBe('verified.secondary@example.com');
    expect(user.isEmailVerified).toBe(true);
  });

  it('4. normalizes valid padded uppercase email, creates full ApiUser and supporting records, without logging email PII', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
    const sensitiveEmail = '  Ada.Lovelace@Example.COM  ';

    getUserMock.mockResolvedValue({
      id: 'clerk_ada',
      primaryEmailAddressId: 'em_1',
      emailAddresses: [{ id: 'em_1', emailAddress: sensitiveEmail, verification: { status: 'verified' } }],
      firstName: 'Ada',
      lastName: 'Lovelace',
      imageUrl: ' https://cdn.example.com/ada.png ',
    });

    const apiUser = await syncClerkUser('clerk_ada');

    expect(apiUser).toMatchObject({
      email: 'ada.lovelace@example.com',
      username: 'ada.lovelace',
      displayName: 'Ada Lovelace',
      avatarUrl: 'https://cdn.example.com/ada.png',
      bio: null,
      timezone: 'UTC',
      isEmailVerified: true,
      role: 'user',
    });
    expect(apiUser.id).toMatch(/^[0-9a-f]{24}$/);
    expect(() => new Date(apiUser.joinedAt).toISOString()).not.toThrow();
    expect(() => new Date(apiUser.lastActiveAt).toISOString()).not.toThrow();

    const dbUser = await User.findById(apiUser.id).lean();
    expect(dbUser?.email).toBe('ada.lovelace@example.com');
    expect(await UserSettings.exists({ userId: apiUser.id })).toBeTruthy();
    expect(await UserProfile.exists({ userId: apiUser.id })).toBeTruthy();

    const logDump = JSON.stringify(infoSpy.mock.calls).toLowerCase();
    expect(logDump).not.toContain('ada.lovelace@example.com');
  });

  it('5. derives valid >= 3 char usernames for short email local parts, short Clerk usernames, and symbol-only handles', async () => {
    const cases = [
      { id: 'clerk_short_1', email: 'ed@gmail.com', username: null },
      { id: 'clerk_short_2', email: 'a@b.co', username: null },
      { id: 'clerk_short_3', email: 'regular@example.com', username: 'ab' },
      { id: 'clerk_short_4', email: '+++@example.com', username: '...' },
    ];

    for (const c of cases) {
      getUserMock.mockResolvedValueOnce({
        id: c.id,
        emailAddresses: [{ id: 'em', emailAddress: c.email, verification: { status: 'verified' } }],
        username: c.username,
        firstName: '   ',
        lastName: '',
      });

      const synced = await syncClerkUser(c.id);
      expect(synced.username.length).toBeGreaterThanOrEqual(3);
      expect(synced.username.length).toBeLessThanOrEqual(30);
      expect(synced.displayName).toBe(synced.username);

      const persisted = await User.findById(synced.id);
      expect(persisted).not.toBeNull();
      await expect(persisted!.validate()).resolves.toBeUndefined();
    }
  });

  it('6. truncates usernames > 30 characters safely and handles collisions when prefixes > 30 characters match', async () => {
    const sharedPrefix = 'very_long_enterprise_developer_name'; // > 30 chars

    getUserMock
      .mockResolvedValueOnce({
        id: 'clerk_long_1',
        emailAddresses: [{ id: 'e1', emailAddress: 'long1@example.com', verification: { status: 'verified' } }],
        username: `${sharedPrefix}_alpha`,
        firstName: 'A'.repeat(140),
      })
      .mockResolvedValueOnce({
        id: 'clerk_long_2',
        emailAddresses: [{ id: 'e2', emailAddress: 'long2@example.com', verification: { status: 'verified' } }],
        username: `${sharedPrefix}_beta`,
      });

    const user1 = await syncClerkUser('clerk_long_1');
    const user2 = await syncClerkUser('clerk_long_2');

    expect(user1.username.length).toBeLessThanOrEqual(30);
    expect(user1.username.length).toBeGreaterThanOrEqual(3);
    expect(user1.displayName.length).toBe(100);

    expect(user2.username.length).toBeLessThanOrEqual(30);
    expect(user2.username.length).toBeGreaterThanOrEqual(3);
    expect(user2.username).not.toBe(user1.username);
  });

  it('7. resolves username collisions while preserving existing owner username', async () => {
    getUserMock
      .mockResolvedValueOnce({
        id: 'clerk_alice_1',
        emailAddresses: [{ id: 'e1', emailAddress: 'alice@example.com', verification: { status: 'verified' } }],
        firstName: 'Alice',
        lastName: 'First',
      })
      .mockResolvedValueOnce({
        id: 'clerk_alice_2',
        emailAddresses: [{ id: 'e2', emailAddress: 'alice@company.org', verification: { status: 'verified' } }],
        firstName: 'Alice',
        lastName: 'Second',
      });

    const owner = await syncClerkUser('clerk_alice_1');
    const newcomer = await syncClerkUser('clerk_alice_2');

    expect(owner.username).toBe('alice');
    expect(newcomer.username).not.toBe('alice');
    expect(newcomer.username.startsWith('alice_')).toBe(true);
    expect(newcomer.username.length).toBeLessThanOrEqual(30);

    const ownerInDb = await User.findById(owner.id).lean();
    expect(ownerInDb?.username).toBe('alice');
  });

  it('8a. preserves valid existing user without calling Clerk API on subsequent syncs', async () => {
    getUserMock.mockResolvedValueOnce({
      id: 'clerk_repeat',
      emailAddresses: [{ id: 'e1', emailAddress: 'repeat@example.com', verification: { status: 'verified' } }],
      username: 'steady_handle',
      firstName: 'Steady',
    });

    const first = await syncClerkUser('clerk_repeat');
    getUserMock.mockClear();

    const second = await syncClerkUser('clerk_repeat');

    expect(getUserMock).not.toHaveBeenCalled();
    expect(second.id).toBe(first.id);
    expect(second.username).toBe('steady_handle');
    expect(second.email).toBe('repeat@example.com');
  });

  it('8b. repairs legacy inconsistent User documents and provisions missing supporting records', async () => {
    const rawInsert = await User.collection.insertOne({
      clerkId: 'clerk_legacy_broken',
      email: '  Legacy.Broken@Example.COM  ',
      username: 'x',
      displayName: '   ',
      avatarUrl: null,
      bio: null,
      isEmailVerified: false,
      role: 'user',
    });

    const repaired = await syncClerkUser('clerk_legacy_broken');

    expect(repaired.id).toBe(rawInsert.insertedId.toString());
    expect(repaired.email).toBe('legacy.broken@example.com');
    expect(repaired.username.length).toBeGreaterThanOrEqual(3);
    expect(repaired.username.length).toBeLessThanOrEqual(30);
    expect(repaired.displayName).toBe(repaired.username);
    expect(repaired.timezone).toBe('UTC');
    expect(await UserSettings.exists({ userId: rawInsert.insertedId })).toBeTruthy();
    expect(await UserProfile.exists({ userId: rawInsert.insertedId })).toBeTruthy();
  });

  it('preserves existing schema-valid usernames containing spaces without silent mutation', async () => {
    const rawInsert = await User.collection.insertOne({
      clerkId: 'clerk_spaced_handle',
      email: 'spaced@example.com',
      username: 'Ada Lovelace',
      displayName: 'Ada Lovelace',
      avatarUrl: null,
      bio: null,
      isEmailVerified: true,
      role: 'user',
    });

    const synced = await syncClerkUser('clerk_spaced_handle');
    expect(synced.id).toBe(rawInsert.insertedId.toString());
    expect(synced.username).toBe('Ada Lovelace');
    expect(synced.displayName).toBe('Ada Lovelace');

    const persisted = await User.findById(rawInsert.insertedId).lean();
    expect(persisted?.username).toBe('Ada Lovelace');
  });

  it('recovers safely from E11000 collision when repairing existing user username', async () => {
    // First user owns "bob"
    await User.create({
      clerkId: 'clerk_bob_owner',
      email: 'bob.owner@example.com',
      username: 'bob',
      displayName: 'Bob Owner',
      isEmailVerified: true,
    });

    // Legacy user with untrimmed "  bob  " which trims to "bob"
    const rawLegacy = await User.collection.insertOne({
      clerkId: 'clerk_bob_legacy',
      email: 'bob.legacy@example.com',
      username: '  bob  ',
      displayName: 'Bob Legacy',
      isEmailVerified: true,
      role: 'user',
    });

    const repaired = await syncClerkUser('clerk_bob_legacy');
    expect(repaired.id).toBe(rawLegacy.insertedId.toString());
    expect(repaired.username).not.toBe('bob');
    expect(repaired.username.startsWith('bob_')).toBe(true);

    const persisted = await User.findById(rawLegacy.insertedId).lean();
    expect(persisted?.username).toBe(repaired.username);
  });

  it('refetches Clerk when legacy document has malformed email and handles 404 or recovers cleanly', async () => {
    const rawLegacy = await User.collection.insertOne({
      clerkId: 'clerk_bad_stored_email',
      email: 'malformed-stored-email',
      username: 'bad_email_user',
      displayName: 'Bad Email User',
      isEmailVerified: false,
      role: 'user',
    });

    // Clerk returns 404/null
    getUserMock.mockResolvedValueOnce(null);
    await expect(syncClerkUser('clerk_bad_stored_email')).rejects.toMatchObject({
      code: 'CLERK_USER_NOT_FOUND',
      statusCode: 404,
    });

    // Clerk returns repaired user profile
    getUserMock.mockResolvedValueOnce({
      id: 'clerk_bad_stored_email',
      emailAddresses: [{ id: 'em_rep', emailAddress: 'repaired@example.com', verification: { status: 'verified' } }],
      username: 'bad_email_user',
    });

    const repaired = await syncClerkUser('clerk_bad_stored_email');
    expect(repaired.id).toBe(rawLegacy.insertedId.toString());
    expect(repaired.email).toBe('repaired@example.com');
  });

  it('8c. blocks account hijacking when verification metadata is unverified, missing, null, or has null status, and forbids overwriting established clerkId', async () => {
    const existing = await User.create({
      clerkId: 'clerk_original_owner',
      email: 'shared.account@example.com',
      username: 'original_owner',
      displayName: 'Original Owner',
      isEmailVerified: true,
    });

    // Attack vector 1: explicitly unverified status
    getUserMock.mockResolvedValueOnce({
      id: 'clerk_unverified_attacker',
      emailAddresses: [
        { id: 'e_unv', emailAddress: 'shared.account@example.com', verification: { status: 'unverified' } },
      ],
    });
    await expect(syncClerkUser('clerk_unverified_attacker')).rejects.toMatchObject({
      code: 'UNVERIFIED_EMAIL_CONFLICT',
      statusCode: 409,
    });
    expect((await User.findById(existing._id).lean())?.clerkId).toBe('clerk_original_owner');

    // Attack vector 2: verification metadata undefined
    getUserMock.mockResolvedValueOnce({
      id: 'clerk_undef_ver_attacker',
      emailAddresses: [
        { id: 'e_undef', emailAddress: 'shared.account@example.com', verification: undefined },
      ],
    });
    await expect(syncClerkUser('clerk_undef_ver_attacker')).rejects.toMatchObject({
      code: 'UNVERIFIED_EMAIL_CONFLICT',
      statusCode: 409,
    });
    expect((await User.findById(existing._id).lean())?.clerkId).toBe('clerk_original_owner');

    // Attack vector 3: verification metadata null
    getUserMock.mockResolvedValueOnce({
      id: 'clerk_null_ver_attacker',
      emailAddresses: [
        { id: 'e_null', emailAddress: 'shared.account@example.com', verification: null },
      ],
    });
    await expect(syncClerkUser('clerk_null_ver_attacker')).rejects.toMatchObject({
      code: 'UNVERIFIED_EMAIL_CONFLICT',
      statusCode: 409,
    });
    expect((await User.findById(existing._id).lean())?.clerkId).toBe('clerk_original_owner');

    // Attack vector 4: verification status is null
    getUserMock.mockResolvedValueOnce({
      id: 'clerk_null_status_attacker',
      emailAddresses: [
        { id: 'e_null_status', emailAddress: 'shared.account@example.com', verification: { status: null } },
      ],
    });
    await expect(syncClerkUser('clerk_null_status_attacker')).rejects.toMatchObject({
      code: 'UNVERIFIED_EMAIL_CONFLICT',
      statusCode: 409,
    });
    expect((await User.findById(existing._id).lean())?.clerkId).toBe('clerk_original_owner');

    // Attack vector 5: second clerk user with VERIFIED email cannot overwrite existing account's clerkId
    getUserMock.mockResolvedValueOnce({
      id: 'clerk_second_verified_attacker',
      emailAddresses: [
        { id: 'e_sec_ver', emailAddress: 'SHARED.ACCOUNT@example.com', verification: { status: 'verified' } },
      ],
    });
    await expect(syncClerkUser('clerk_second_verified_attacker')).rejects.toMatchObject({
      code: 'CLERK_IDENTITY_CONFLICT',
      statusCode: 409,
    });
    // Original owner remains untouched
    expect((await User.findById(existing._id).lean())?.clerkId).toBe('clerk_original_owner');
  });

  it('links an unlinked existing user when email is positively verified, and blocks linking when unverified', async () => {
    // Unlinked legacy user (clerkId is empty string)
    const unlinked = await User.collection.insertOne({
      clerkId: '',
      email: 'unlinked.account@example.com',
      username: 'unlinked_user',
      displayName: 'Unlinked User',
      avatarUrl: null,
      bio: null,
      isEmailVerified: false,
      role: 'user',
    });

    // Attempt to link with unverified email must fail
    getUserMock.mockResolvedValueOnce({
      id: 'clerk_unverified_candidate',
      emailAddresses: [
        { id: 'e_unv', emailAddress: 'unlinked.account@example.com', verification: { status: 'unverified' } },
      ],
    });
    await expect(syncClerkUser('clerk_unverified_candidate')).rejects.toMatchObject({
      code: 'UNVERIFIED_EMAIL_CONFLICT',
      statusCode: 409,
    });
    expect((await User.findById(unlinked.insertedId).lean())?.clerkId).toBe('');

    // Attempt to link with verified email succeeds
    getUserMock.mockResolvedValueOnce({
      id: 'clerk_verified_candidate',
      emailAddresses: [
        { id: 'e_ver', emailAddress: 'unlinked.account@example.com', verification: { status: 'verified' } },
      ],
      imageUrl: 'https://cdn.example.com/avatar.png',
    });

    const linked = await syncClerkUser('clerk_verified_candidate');
    expect(linked.id).toBe(unlinked.insertedId.toString());
    expect(linked.avatarUrl).toBe('https://cdn.example.com/avatar.png');
    expect((await User.findById(unlinked.insertedId).lean())?.clerkId).toBe('clerk_verified_candidate');
  });

  it('9. ensures duplicate sequential deliveries are idempotent with a single user and supporting docs', async () => {
    getUserMock.mockResolvedValue({
      id: 'clerk_idempotent',
      emailAddresses: [{ id: 'e1', emailAddress: 'dup@example.com', verification: { status: 'verified' } }],
      username: 'dup_user',
      firstName: 'Dup',
      lastName: 'User',
    });

    const first = await syncClerkUser('clerk_idempotent');
    const second = await syncClerkUser('clerk_idempotent');
    const third = await syncClerkUser('clerk_idempotent');

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(second.username).toBe(first.username);

    expect(await User.countDocuments({ clerkId: 'clerk_idempotent' })).toBe(1);
    expect(await UserSettings.countDocuments({ userId: first.id })).toBe(1);
    expect(await UserProfile.countDocuments({ userId: first.id })).toBe(1);
  });

  it('10. handles concurrent sync requests for the same clerkId and competing username derivations cleanly', async () => {
    getUserMock.mockImplementation(async (id: string) => {
      if (id === 'clerk_concurrent_same') {
        return {
          id,
          emailAddresses: [{ id: 'e1', emailAddress: 'same@example.com', verification: { status: 'verified' } }],
          username: 'same_concurrent',
          firstName: 'Same',
        };
      }
      if (id === 'clerk_compete_1') {
        return {
          id,
          emailAddresses: [{ id: 'e2', emailAddress: 'sam@one.example.com', verification: { status: 'verified' } }],
          firstName: 'Sam',
        };
      }
      return {
        id,
        emailAddresses: [{ id: 'e3', emailAddress: 'sam@two.example.com', verification: { status: 'verified' } }],
        firstName: 'Sam',
      };
    });

    const [sameA, sameB] = await Promise.all([
      syncClerkUser('clerk_concurrent_same'),
      syncClerkUser('clerk_concurrent_same'),
    ]);

    expect(sameA.id).toBe(sameB.id);
    expect(sameA.username).toBe(sameB.username);
    expect(await User.countDocuments({ clerkId: 'clerk_concurrent_same' })).toBe(1);

    const [compA, compB] = await Promise.all([
      syncClerkUser('clerk_compete_1'),
      syncClerkUser('clerk_compete_2'),
    ]);

    expect(compA.id).not.toBe(compB.id);
    expect(compA.username).not.toBe(compB.username);
    expect(compA.username.length).toBeGreaterThanOrEqual(3);
    expect(compB.username.length).toBeGreaterThanOrEqual(3);
  });

  it('11. recovers from E11000 duplicate key errors on username, concurrent clerkId creation, UserSettings, and UserProfile', async () => {
    getUserMock.mockResolvedValue({
      id: 'clerk_dup_username',
      emailAddresses: [{ id: 'e1', emailAddress: 'race@example.com', verification: { status: 'verified' } }],
      username: 'race_handle',
      firstName: 'Race',
    });

    const createSpy = vi
      .spyOn(User, 'create')
      .mockRejectedValueOnce(makeDuplicateKeyError({ username: 1 }));

    const recovered = await syncClerkUser('clerk_dup_username');
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(recovered.username).not.toBe('race_handle');
    expect(recovered.username.startsWith('race_handle_')).toBe(true);

    createSpy.mockRestore();

    // Simulated race where UserSettings already got inserted concurrently
    getUserMock.mockResolvedValueOnce({
      id: 'clerk_settings_dup',
      emailAddresses: [{ id: 'e2', emailAddress: 'settingsdup@example.com', verification: { status: 'verified' } }],
      username: 'settings_dup',
    });
    const realSettingsCreate = UserSettings.create.bind(UserSettings);
    vi.spyOn(UserSettings, 'create').mockImplementationOnce(async (doc: unknown) => {
      await realSettingsCreate(doc as Parameters<typeof UserSettings.create>[0]);
      throw makeDuplicateKeyError({ userId: 1 });
    });

    const settingsRecovered = await syncClerkUser('clerk_settings_dup');
    expect(await UserSettings.countDocuments({ userId: settingsRecovered.id })).toBe(1);

    // Simulated race where UserProfile already got inserted concurrently
    getUserMock.mockResolvedValueOnce({
      id: 'clerk_profile_dup',
      emailAddresses: [{ id: 'e2b', emailAddress: 'profiledup@example.com', verification: { status: 'verified' } }],
      username: 'profile_dup',
    });
    const realProfileCreate = UserProfile.create.bind(UserProfile);
    vi.spyOn(UserProfile, 'create').mockImplementationOnce(async (doc: unknown) => {
      await realProfileCreate(doc as Parameters<typeof UserProfile.create>[0]);
      throw makeDuplicateKeyError({ userId: 1 });
    });

    const profileRecovered = await syncClerkUser('clerk_profile_dup');
    expect(await UserProfile.countDocuments({ userId: profileRecovered.id })).toBe(1);

    // Unrecoverable persistent E11000 on clerkId must fail bounded with 409 USER_SYNC_CONFLICT
    getUserMock.mockResolvedValue({
      id: 'clerk_persistent_conflict',
      emailAddresses: [{ id: 'e3', emailAddress: 'conflict@example.com', verification: { status: 'verified' } }],
      username: 'conflict_user',
    });
    vi.spyOn(User, 'create').mockRejectedValue(makeDuplicateKeyError({ clerkId: 1 }));

    await expect(syncClerkUser('clerk_persistent_conflict')).rejects.toMatchObject({
      code: 'USER_SYNC_CONFLICT',
      statusCode: 409,
    });
  });

  it('recovers deterministically when concurrent insert causes E11000 on email or clerkId', async () => {
    // Concurrent insert for the same clerkId
    getUserMock.mockResolvedValueOnce({
      id: 'clerk_concurrent_clerkid',
      emailAddresses: [{ id: 'e1', emailAddress: 'concurrent.clerkid@example.com', verification: { status: 'verified' } }],
      username: 'conc_clerkid',
    });

    vi.spyOn(User, 'create').mockImplementationOnce(async () => {
      // Simulate that another request inserted the user right before this User.create
      await User.collection.insertOne({
        clerkId: 'clerk_concurrent_clerkid',
        email: 'concurrent.clerkid@example.com',
        username: 'conc_clerkid_first',
        displayName: 'Concurrent Winner',
        avatarUrl: null,
        bio: null,
        timezone: 'UTC',
        isEmailVerified: true,
        role: 'user',
        joinedAt: new Date(),
        lastActiveAt: new Date(),
      });
      throw makeDuplicateKeyError({ clerkId: 1 });
    });

    const recoveredClerk = await syncClerkUser('clerk_concurrent_clerkid');
    expect(recoveredClerk.username).toBe('conc_clerkid_first');
    expect(recoveredClerk.email).toBe('concurrent.clerkid@example.com');
    const persisted = await User.findById(recoveredClerk.id).lean();
    expect(persisted?.clerkId).toBe('clerk_concurrent_clerkid');

    // Concurrent insert for the same email
    getUserMock.mockResolvedValueOnce({
      id: 'clerk_concurrent_email_winner',
      emailAddresses: [{ id: 'e2', emailAddress: 'concurrent.email@example.com', verification: { status: 'verified' } }],
      username: 'email_racer',
    });

    vi.spyOn(User, 'create').mockImplementationOnce(async () => {
      // Another request inserted an unlinked user with this email
      await User.collection.insertOne({
        clerkId: '',
        email: 'concurrent.email@example.com',
        username: 'unlinked_email_first',
        displayName: 'Email Winner',
        avatarUrl: null,
        bio: null,
        timezone: 'UTC',
        isEmailVerified: true,
        role: 'user',
        joinedAt: new Date(),
        lastActiveAt: new Date(),
      });
      throw makeDuplicateKeyError({ email: 1 });
    });

    const recoveredEmail = await syncClerkUser('clerk_concurrent_email_winner');
    expect(recoveredEmail.email).toBe('concurrent.email@example.com');
    expect(recoveredEmail.username).toBe('unlinked_email_first');
  });

  it('12. propagates non-11000 database failures cleanly and completes partial provisioning on retry', async () => {
    getUserMock.mockResolvedValue({
      id: 'clerk_partial_retry',
      emailAddresses: [{ id: 'e1', emailAddress: 'retry@example.com', verification: { status: 'verified' } }],
      username: 'retry_user',
      firstName: 'Retry',
      lastName: 'User',
    });

    const dbTimeoutError = new Error('MongoNetworkTimeoutError: socket timed out');
    const profileCreateSpy = vi
      .spyOn(UserProfile, 'create')
      .mockRejectedValueOnce(dbTimeoutError);

    await expect(syncClerkUser('clerk_partial_retry')).rejects.toThrow(
      'MongoNetworkTimeoutError: socket timed out',
    );

    const createdUser = await User.findOne({ clerkId: 'clerk_partial_retry' }).lean();
    expect(createdUser).not.toBeNull();
    expect(await UserSettings.exists({ userId: createdUser!._id })).toBeTruthy();
    expect(await UserProfile.exists({ userId: createdUser!._id })).toBeFalsy();

    profileCreateSpy.mockRestore();

    const completed = await syncClerkUser('clerk_partial_retry');
    expect(completed.id).toBe(createdUser!._id.toString());
    expect(await User.countDocuments({ clerkId: 'clerk_partial_retry' })).toBe(1);
    expect(await UserSettings.countDocuments({ userId: createdUser!._id })).toBe(1);
    expect(await UserProfile.countDocuments({ userId: createdUser!._id })).toBe(1);
  });
});
