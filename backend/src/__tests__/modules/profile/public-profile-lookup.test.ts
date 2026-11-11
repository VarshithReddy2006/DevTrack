import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('still finds the user case-insensitively', async () => {
    const user = await makeUser('john.doe');
    await makeUser('johnxdoe');

    await PublicProfileService.getPublicProfileByUsername('John.Doe', '127.0.0.1', 'public');

    expect(computeProfile).toHaveBeenCalledTimes(1);
    expect(String(computeProfile.mock.calls[0][0])).toBe(String(user._id));
  });
});
