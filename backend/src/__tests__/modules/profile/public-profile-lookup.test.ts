import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicProfile } from '../../../db/models/publicProfile.model.js';
import { User } from '../../../db/models/user.model.js';
import { PublicProfileService } from '../../../modules/profile/publicProfile.service.js';

async function makeUser(username: string) {
  return User.create({
    clerkId: `clerk_${username}`,
    username,
    displayName: username,
    email: `${username}@example.test`,
  });
}

describe('PublicProfileService.getPublicProfileByUsername lookup', () => {
  let computeProfile: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    computeProfile = vi.spyOn(PublicProfileService, 'computeProfile').mockResolvedValue({ trustScore: 0, suspicionScore: 0, flags: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not throw a regex error for a username like c++', async () => {
    await expect(
      PublicProfileService.getPublicProfileByUsername('c++', '127.0.0.1', 'public'),
    ).rejects.toThrow('Profile not found');
    expect(computeProfile).not.toHaveBeenCalled();
  });

  it('treats . in the username as a literal dot', async () => {
    await makeUser('johnxdoe');

    await expect(
      PublicProfileService.getPublicProfileByUsername('john.doe', '127.0.0.1', 'public'),
    ).rejects.toThrow('Profile not found');
    expect(computeProfile).not.toHaveBeenCalled();
  });

  it('finds a published profile by handle, case-insensitively, without a user lookup', async () => {
    const user = await makeUser('john.doe');
    await PublicProfile.create({
      userId: user._id, username: 'john.doe', slug: 'john.doe', published: true, visibility: 'public',
      snapshot: { version: 2 },
    });

    const profile = await PublicProfileService.getPublicProfileByUsername('John.Doe', '127.0.0.1', 'public');

    expect(String(profile.userId)).toBe(String(user._id));
    expect(computeProfile).not.toHaveBeenCalled();
  });

  it('does not build or serve a profile for a user who never published', async () => {
    await makeUser('quietuser');
    await expect(
      PublicProfileService.getPublicProfileByUsername('QuietUser', '127.0.0.1', 'public'),
    ).rejects.toThrow('Profile not found');
    expect(computeProfile).not.toHaveBeenCalled();
    expect(await PublicProfile.countDocuments()).toBe(0);
  });
});
