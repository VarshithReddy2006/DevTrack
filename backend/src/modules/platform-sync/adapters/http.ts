import { logger } from '../../../shared/logger.js';
import { fetchWithTimeout } from '../../../shared/fetchWithTimeout.js';

export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retries = 3,
  backoff = 1000
): Promise<Response> {
  try {
    const res = await fetchWithTimeout(url, options);

    // Retry on 5xx errors or 429 (Too Many Requests)
    if ((res.status >= 500 || res.status === 429) && retries > 0) {
      const delay = backoff * (2 ** (3 - retries)) + Math.random() * 100;
      logger.warn(`Sync fetch failed (${res.status}). Retrying in ${Math.round(delay)}ms...`, { url, retriesLeft: retries - 1 });
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchWithRetry(url, options, retries - 1, backoff);
    }

    return res;
  } catch (err) {
    if (retries > 0) {
      const delay = backoff * (2 ** (3 - retries)) + Math.random() * 100;
      logger.warn(`Sync fetch error (${err instanceof Error ? err.message : 'Unknown'}). Retrying...`, { url, retriesLeft: retries - 1 });
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchWithRetry(url, options, retries - 1, backoff);
    }
    throw err;
  }
}
