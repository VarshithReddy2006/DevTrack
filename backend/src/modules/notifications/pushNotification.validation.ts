import { ECDH } from 'node:crypto';
import { z } from 'zod';

// Subscription URLs are outbound destinations. Only browser push providers may
// receive requests; arbitrary HTTPS URLs would make this an authenticated SSRF.
export function isPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      !url.port && !url.hash && url.pathname !== '/' && (
        url.hostname === 'fcm.googleapis.com' ||
        url.hostname === 'updates.push.services.mozilla.com' ||
        url.hostname === 'web.push.apple.com' ||
        /^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname)
      );
  } catch {
    return false;
  }
}

const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const pushEndpointSchema = z.string().max(2048).refine(isPushEndpoint, 'Unsupported push endpoint');
export const pushSubscriptionSchema = z.object({
  endpoint: pushEndpointSchema,
  expirationTime: z.number().nonnegative().nullable().optional()
    .refine((value) => value == null || value > Date.now(), 'Subscription has expired'),
  keys: z.object({
    p256dh: base64url.length(87).refine((value) => {
      try {
        const key = Buffer.from(value, 'base64url');
        return key.length === 65 && key[0] === 4 &&
          ECDH.convertKey(key, 'prime256v1').length === 65;
      } catch {
        return false;
      }
    }, 'Invalid P-256 public key'),
    auth: base64url.length(22).refine((value) => Buffer.from(value, 'base64url').length === 16, 'Invalid auth secret'),
  }),
  // Echo the key used by pushManager.subscribe to detect rotation races.
  vapidPublicKey: base64url.length(87).optional(),
});

export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;
