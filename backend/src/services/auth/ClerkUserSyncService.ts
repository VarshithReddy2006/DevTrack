// src/services/auth/ClerkUserSyncService.ts
import { createHash, randomBytes } from 'node:crypto';
import { clerkClient } from '@clerk/express';
import { z } from 'zod';
import { User, UserSettings, UserProfile, type IUser } from '../../db/models/index.js';
import { logger } from '../../shared/logger.js';
import type { ApiUser } from '../../types/api.types.js';

const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 30;
const DISPLAY_NAME_MAX_LENGTH = 100;
const EMAIL_MAX_LENGTH = 254;
const MAX_USERNAME_ATTEMPTS = 12;

const emailSchema = z.string().trim().toLowerCase().max(EMAIL_MAX_LENGTH).email();

interface ClerkEmailAddressLike {
  id?: string | null;
  emailAddress?: unknown;
  verification?: { status?: string | null } | null;
}

interface ClerkUserLike {
  id?: string;
  primaryEmailAddressId?: string | null;
  emailAddresses?: ClerkEmailAddressLike[] | null;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  imageUrl?: string | null;
}

interface ResolvedEmail {
  email: string;
  isVerified: boolean;
}

function createAuthSyncError(message: string, code: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { code?: unknown; cause?: { code?: unknown } };
  return err.code === 11000 || err.cause?.code === 11000;
}

function getDuplicateKeyField(error: unknown): 'clerkId' | 'email' | 'username' | 'userId' | null {
  if (!error || typeof error !== 'object') return null;
  const err = error as {
    keyPattern?: Record<string, unknown>;
    keyValue?: Record<string, unknown>;
    message?: string;
    cause?: {
      keyPattern?: Record<string, unknown>;
      keyValue?: Record<string, unknown>;
      message?: string;
    };
  };
  const source = err.keyPattern || err.keyValue ? err : (err.cause ?? err);
  const keys = [
    ...Object.keys(source.keyPattern ?? {}),
    ...Object.keys(source.keyValue ?? {}),
  ];
  if (keys.includes('clerkId')) return 'clerkId';
  if (keys.includes('email')) return 'email';
  if (keys.includes('username')) return 'username';
  if (keys.includes('userId')) return 'userId';
  const msg = (err.message ?? err.cause?.message ?? '').toLowerCase();
  if (msg.includes('clerkid')) return 'clerkId';
  if (msg.includes('email')) return 'email';
  if (msg.includes('username')) return 'username';
  if (msg.includes('userid')) return 'userId';
  return null;
}

function resolveClerkEmail(clerkUser: ClerkUserLike | null | undefined): ResolvedEmail {
  const entries = Array.isArray(clerkUser?.emailAddresses) ? clerkUser.emailAddresses : [];
  const primaryId = clerkUser?.primaryEmailAddressId;

  // Prioritize verified addresses:
  // 1. Primary verified
  // 2. Secondary verified
  // 3. Primary unverified
  // 4. Secondary unverified
  const orderedEntries: ClerkEmailAddressLike[] = [
    ...entries.filter((entry) => entry?.id === primaryId && entry?.verification?.status === 'verified'),
    ...entries.filter((entry) => entry?.id !== primaryId && entry?.verification?.status === 'verified'),
    ...entries.filter((entry) => entry?.id === primaryId && entry?.verification?.status !== 'verified'),
    ...entries.filter((entry) => entry?.id !== primaryId && entry?.verification?.status !== 'verified'),
  ];

  let sawNonEmptyInvalid = false;
  for (const entry of orderedEntries) {
    if (typeof entry?.emailAddress !== 'string') continue;
    const trimmed = entry.emailAddress.trim();
    if (!trimmed) continue;

    const parsed = emailSchema.safeParse(trimmed);
    if (parsed.success) {
      const status = entry.verification?.status ?? null;
      return {
        email: parsed.data,
        isVerified: status === 'verified',
      };
    }
    sawNonEmptyInvalid = true;
  }

  throw createAuthSyncError(
    sawNonEmptyInvalid
      ? 'A valid email address is required for user synchronization'
      : 'Email address is required for user synchronization',
    sawNonEmptyInvalid ? 'INVALID_EMAIL' : 'EMAIL_REQUIRED',
    400,
  );
}

function deterministicHash(clerkUserId: string, salt: string, length: number): string {
  return createHash('sha256').update(`${clerkUserId}:${salt}`).digest('hex').slice(0, length);
}

function isSchemaValidUsername(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return (
    trimmed.length >= USERNAME_MIN_LENGTH &&
    trimmed.length <= USERNAME_MAX_LENGTH &&
    !/[\x00-\x1f\x7f]/.test(trimmed)
  );
}

function clipUsername(value: string, maxLength: number): string {
  const clipped = value.slice(0, maxLength).replace(/[._-]+$/, '');
  return clipped.length >= USERNAME_MIN_LENGTH ? clipped : value.slice(0, maxLength);
}

function normalizeUsernameBase(
  rawUsername: string | null | undefined,
  normalizedEmail: string,
  clerkUserId: string,
): string {
  const emailLocal = normalizedEmail.slice(0, normalizedEmail.indexOf('@'));
  const candidate =
    typeof rawUsername === 'string' && rawUsername.trim().length > 0
      ? rawUsername.trim()
      : emailLocal;

  const sanitized = candidate
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');

  if (!sanitized) {
    return `user_${deterministicHash(clerkUserId, 'empty', 8)}`;
  }
  if (sanitized.length < USERNAME_MIN_LENGTH) {
    return `${sanitized}_${deterministicHash(clerkUserId, 'pad', 4)}`;
  }
  if (sanitized.length > USERNAME_MAX_LENGTH) {
    return clipUsername(sanitized, USERNAME_MAX_LENGTH);
  }
  return sanitized;
}

function buildUsernameCandidate(base: string, clerkUserId: string, attempt: number): string {
  if (attempt === 0) return base;
  const suffix =
    attempt < 10
      ? `_${deterministicHash(clerkUserId, `collision:${attempt}`, attempt === 1 ? 4 : 6)}`
      : `_${randomBytes(3).toString('hex')}`;
  const maxPrefix = USERNAME_MAX_LENGTH - suffix.length;
  const rawPrefix = base.slice(0, maxPrefix);
  const trimmedPrefix = rawPrefix.replace(/[._-]+$/, '');
  const prefix = trimmedPrefix.length > 0 ? trimmedPrefix : rawPrefix;
  return `${prefix}${suffix}`;
}

async function resolveUniqueUsername(
  base: string,
  clerkUserId: string,
  startAttempt = 0,
  excludeUserId?: string,
): Promise<{ username: string; nextAttempt: number }> {
  for (let attempt = startAttempt; attempt < MAX_USERNAME_ATTEMPTS; attempt++) {
    const candidate = buildUsernameCandidate(base, clerkUserId, attempt);
    const existing = await User.findOne({ username: candidate }).select('_id').lean();
    if (!existing || (excludeUserId && existing._id.toString() === excludeUserId)) {
      return { username: candidate, nextAttempt: attempt + 1 };
    }
  }
  throw createAuthSyncError(
    'Unable to allocate a unique username during synchronization',
    'USERNAME_ALLOCATION_FAILED',
    409,
  );
}

function deriveDisplayName(
  clerkUser: ClerkUserLike | null | undefined,
  fallbackUsername: string,
): string {
  const fullName = [clerkUser?.firstName, clerkUser?.lastName]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.trim())
    .join(' ');
  const resolved = (fullName || fallbackUsername).trim();
  return resolved.slice(0, DISPLAY_NAME_MAX_LENGTH);
}

async function ensureSupportingDoc(
  model: {
    exists: (filter: { userId: IUser['_id'] }) => Promise<unknown>;
    create: (doc: { userId: IUser['_id'] }) => Promise<unknown>;
  },
  userId: IUser['_id'],
): Promise<void> {
  if (await model.exists({ userId })) return;
  try {
    await model.create({ userId });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }
}

async function ensureSupportingRecords(userId: IUser['_id']): Promise<void> {
  const results = await Promise.allSettled([
    ensureSupportingDoc(UserSettings, userId),
    ensureSupportingDoc(UserProfile, userId),
  ]);
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failed) throw failed.reason;
}

function toApiUser(user: IUser): ApiUser {
  const now = new Date();
  const joinedAt = user.joinedAt instanceof Date ? user.joinedAt : now;
  const lastActiveAt = user.lastActiveAt instanceof Date ? user.lastActiveAt : now;

  return {
    id: user._id.toString(),
    email: user.email,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl ?? null,
    bio: user.bio ?? null,
    timezone: user.timezone || 'UTC',
    joinedAt: joinedAt.toISOString(),
    lastActiveAt: lastActiveAt.toISOString(),
    isEmailVerified: Boolean(user.isEmailVerified),
    role: user.role === 'admin' ? 'admin' : 'user',
  };
}

async function repairAndPersistExistingUser(
  existingUser: IUser,
  clerkUserId: string,
  normalizedEmail: string,
  clerkUser?: ClerkUserLike,
  resolvedEmail?: ResolvedEmail,
  extraFields: Record<string, unknown> = {},
): Promise<ApiUser> {
  const now = new Date();
  const baseFields: Record<string, unknown> = {
    lastActiveAt: now,
    ...extraFields,
  };

  if (existingUser.email !== normalizedEmail) {
    baseFields.email = normalizedEmail;
  }
  if (resolvedEmail?.isVerified && !existingUser.isEmailVerified) {
    baseFields.isEmailVerified = true;
  }
  if (!(existingUser.joinedAt instanceof Date)) {
    baseFields.joinedAt = now;
  }
  if (!existingUser.timezone) {
    baseFields.timezone = 'UTC';
  }
  if (!existingUser.role) {
    baseFields.role = 'user';
  }

  const hasValidUsername = isSchemaValidUsername(existingUser.username);
  const hasValidDisplayName =
    typeof existingUser.displayName === 'string' && existingUser.displayName.trim().length > 0;

  const preservedUsername = hasValidUsername ? existingUser.username.trim() : null;
  const usernameBase = hasValidUsername
    ? preservedUsername!
    : normalizeUsernameBase(
        clerkUser?.username ?? existingUser.username,
        normalizedEmail,
        clerkUserId,
      );

  let updatedUser: IUser | null = null;
  let attempt = 0;

  while (attempt < MAX_USERNAME_ATTEMPTS) {
    let candidateUsername: string;
    if (hasValidUsername && attempt === 0) {
      candidateUsername = preservedUsername!;
    } else {
      const { username: allocated, nextAttempt } = await resolveUniqueUsername(
        usernameBase,
        clerkUserId,
        attempt,
        existingUser._id.toString(),
      );
      candidateUsername = allocated;
      attempt = nextAttempt - 1;
    }

    const fieldsToSet: Record<string, unknown> = {
      ...baseFields,
      username: candidateUsername,
      displayName: hasValidDisplayName
        ? (existingUser.displayName.length > DISPLAY_NAME_MAX_LENGTH
            ? existingUser.displayName.trim().slice(0, DISPLAY_NAME_MAX_LENGTH)
            : existingUser.displayName.trim())
        : deriveDisplayName(clerkUser, candidateUsername),
    };

    try {
      updatedUser = await User.findByIdAndUpdate(
        existingUser._id,
        { $set: fieldsToSet },
        { new: true, runValidators: true },
      );
      break;
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;

      const concurrentByClerk = await User.findOne({ clerkId: clerkUserId });
      if (concurrentByClerk && concurrentByClerk._id.toString() !== existingUser._id.toString()) {
        return await syncExistingUser(concurrentByClerk, clerkUserId, clerkUser);
      }

      const dupField = getDuplicateKeyField(error);
      if (dupField === 'email' || dupField === 'clerkId') {
        throw createAuthSyncError(
          'Conflicting identity constraint encountered during synchronization',
          'USER_SYNC_CONFLICT',
          409,
        );
      }
      attempt++;
    }
  }

  if (!updatedUser) {
    throw createAuthSyncError(
      'Unable to allocate a unique username during synchronization',
      'USERNAME_ALLOCATION_FAILED',
      409,
    );
  }

  await ensureSupportingRecords(updatedUser._id);
  return toApiUser(updatedUser);
}

async function syncExistingUser(
  existingUser: IUser,
  clerkUserId: string,
  prefetchedClerkUser?: ClerkUserLike,
): Promise<ApiUser> {
  const parsedStoredEmail =
    typeof existingUser.email === 'string' ? emailSchema.safeParse(existingUser.email) : null;
  const needsEmailRepair = !parsedStoredEmail?.success;

  let clerkUser = prefetchedClerkUser;
  let resolvedEmail: ResolvedEmail | undefined;
  if (needsEmailRepair) {
    clerkUser = clerkUser ?? ((await clerkClient.users.getUser(clerkUserId)) as ClerkUserLike);
    if (!clerkUser) {
      throw createAuthSyncError('Clerk user profile not found', 'CLERK_USER_NOT_FOUND', 404);
    }
    resolvedEmail = resolveClerkEmail(clerkUser);
  }

  const normalizedEmail = parsedStoredEmail?.success
    ? parsedStoredEmail.data
    : resolvedEmail!.email;

  return repairAndPersistExistingUser(
    existingUser,
    clerkUserId,
    normalizedEmail,
    clerkUser,
    resolvedEmail,
  );
}

async function linkExistingEmailUser(
  existingByEmail: IUser,
  clerkUserId: string,
  clerkUser: ClerkUserLike,
  resolvedEmail: ResolvedEmail,
): Promise<ApiUser> {
  // Security Guard 1: An unverified or missing/null verification email can NEVER link to an existing account.
  if (!resolvedEmail.isVerified) {
    throw createAuthSyncError(
      'Email verification is required before linking an existing account',
      'UNVERIFIED_EMAIL_CONFLICT',
      409,
    );
  }

  // Security Guard 2: Never overwrite an existing account's clerkId based solely on email equality.
  if (existingByEmail.clerkId && existingByEmail.clerkId !== clerkUserId) {
    throw createAuthSyncError(
      'An existing account with this email is already linked to another Clerk identity',
      'CLERK_IDENTITY_CONFLICT',
      409,
    );
  }

  const extraFields: Record<string, unknown> = { clerkId: clerkUserId };
  if (
    !existingByEmail.avatarUrl &&
    typeof clerkUser.imageUrl === 'string' &&
    clerkUser.imageUrl.trim().length > 0
  ) {
    extraFields.avatarUrl = clerkUser.imageUrl.trim();
  }

  const apiUser = await repairAndPersistExistingUser(
    existingByEmail,
    clerkUserId,
    resolvedEmail.email,
    clerkUser,
    resolvedEmail,
    extraFields,
  );

  logger.info('[SYNC] Linked existing local user to Clerk account', {
    userId: apiUser.id,
    clerkUserId,
  });

  return apiUser;
}

export async function syncClerkUser(clerkUserId: string): Promise<ApiUser> {
  const normalizedClerkId = typeof clerkUserId === 'string' ? clerkUserId.trim() : '';
  if (!normalizedClerkId) {
    throw createAuthSyncError('Valid Clerk user ID is required', 'INVALID_CLERK_USER_ID', 400);
  }

  const existing = await User.findOne({ clerkId: normalizedClerkId });
  if (existing) {
    return await syncExistingUser(existing, normalizedClerkId);
  }

  logger.info('[SYNC] New Clerk user detected, fetching details...', {
    clerkUserId: normalizedClerkId,
  });

  const clerkUser = (await clerkClient.users.getUser(normalizedClerkId)) as ClerkUserLike;
  if (!clerkUser) {
    throw createAuthSyncError('Clerk user profile not found', 'CLERK_USER_NOT_FOUND', 404);
  }

  let resolvedEmail: ResolvedEmail;
  try {
    resolvedEmail = resolveClerkEmail(clerkUser);
  } catch (error) {
    logger.warn('[SYNC] Rejected Clerk user synchronization due to invalid or missing email', {
      clerkUserId: normalizedClerkId,
      code: (error as { code?: string }).code,
    });
    throw error;
  }

  const usernameBase = normalizeUsernameBase(
    clerkUser.username,
    resolvedEmail.email,
    normalizedClerkId,
  );
  const avatarUrl =
    typeof clerkUser.imageUrl === 'string' && clerkUser.imageUrl.trim().length > 0
      ? clerkUser.imageUrl.trim()
      : null;

  let attempt = 0;
  let identityRetry = 0;
  while (attempt < MAX_USERNAME_ATTEMPTS) {
    const raceByClerkId = await User.findOne({ clerkId: normalizedClerkId });
    if (raceByClerkId) {
      return await syncExistingUser(raceByClerkId, normalizedClerkId, clerkUser);
    }

    const existingByEmail = await User.findOne({ email: resolvedEmail.email });
    if (existingByEmail) {
      return await linkExistingEmailUser(existingByEmail, normalizedClerkId, clerkUser, resolvedEmail);
    }

    const { username, nextAttempt } = await resolveUniqueUsername(
      usernameBase,
      normalizedClerkId,
      attempt,
    );
    attempt = nextAttempt;
    const displayName = deriveDisplayName(clerkUser, username);

    let createdUser: IUser;
    try {
      createdUser = await User.create({
        clerkId: normalizedClerkId,
        email: resolvedEmail.email,
        username,
        displayName,
        avatarUrl,
        isEmailVerified: resolvedEmail.isVerified,
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;

      const concurrentByClerkId = await User.findOne({ clerkId: normalizedClerkId });
      if (concurrentByClerkId) {
        return await syncExistingUser(concurrentByClerkId, normalizedClerkId, clerkUser);
      }

      const concurrentByEmail = await User.findOne({ email: resolvedEmail.email });
      if (concurrentByEmail) {
        return await linkExistingEmailUser(
          concurrentByEmail,
          normalizedClerkId,
          clerkUser,
          resolvedEmail,
        );
      }

      const dupField = getDuplicateKeyField(error);
      if ((dupField === 'clerkId' || dupField === 'email') && ++identityRetry > 2) {
        throw createAuthSyncError(
          'Conflicting identity constraint encountered during synchronization',
          'USER_SYNC_CONFLICT',
          409,
        );
      }
      continue;
    }

    await ensureSupportingRecords(createdUser._id);
    logger.info('[SYNC] Successfully synced Clerk user to local profile', {
      userId: createdUser._id.toString(),
      clerkUserId: normalizedClerkId,
    });
    return toApiUser(createdUser);
  }

  throw createAuthSyncError(
    'Unable to complete user synchronization after maximum attempts',
    'USER_SYNC_FAILED',
    409,
  );
}
