import { User } from '../db/models/user.model.js';
import { resolveTimezone } from './date.js';

export async function getUserTimezone(userId: string): Promise<string> {
  const user = await User.findById(userId).select('timezone').lean();
  return resolveTimezone(user?.timezone);
}
