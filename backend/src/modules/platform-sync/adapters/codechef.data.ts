import { logger } from '../../../shared/logger.js';
import { fetchWithRetry } from './http.js';
import type { FetchedPlatformStats } from './types.js';
import * as cheerio from 'cheerio';

export async function fetchStatsData(username: string): Promise<FetchedPlatformStats> {
  const url = `https://www.codechef.com/users/${encodeURIComponent(username)}`;
  logger.info(`CodeChef scraping started for user: ${username}`, { url });

  // Fetch with realistic browser User-Agent
  const res = await fetchWithRetry(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
  });

  logger.info(`CodeChef scrape response status: ${res.status}`, { url });

  if (!res.ok) {
    if (res.status === 404) {
      logger.error('CodeChef user not found', { username, url });
      throw new Error('CodeChef user not found');
    }
    const errorText = await res.text().catch(() => 'No response body');
    logger.error(`CodeChef scrape error (${res.status})`, { username, url, errorText: errorText.slice(0, 200) });
    throw new Error(`CodeChef scrape error (${res.status})`);
  }

  // CodeChef redirects non-existent users with HTTP 302 to the homepage
  if (res.redirected && (!res.url.includes('/users/') || res.url.replace(/\/$/, '') === 'https://www.codechef.com')) {
    logger.error('CodeChef user not found (redirected to homepage)', { username, url, redirectedUrl: res.url });
    throw new Error('CodeChef user not found');
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  // Parse rating - look for .rating-number
  let rating: number | null = null;
  const ratingEl = $('.rating-number').first();
  if (ratingEl.length) {
    const ratingText = ratingEl.text().trim();
    const parsed = parseInt(ratingText, 10);
    if (!isNaN(parsed)) {
      rating = parsed;
    }
  }
  logger.info('CodeChef rating parsed', { username, rating });

  // Parse highest rating (may be in different location)
  let highestRating: number | null = null;
  const highestEl = $('.rating-header .highest').first();
  if (highestEl.length) {
    const highestText = highestEl.text().replace(/[^0-9]/g, '');
    const parsed = parseInt(highestText, 10);
    if (!isNaN(parsed)) {
      highestRating = parsed;
    }
  }

  // Parse global rank (if available)
  let globalRank: string | null = null;
  const rankEl = $('.profile-loaction-item').filter(function() {
    return $(this).text().toLowerCase().includes('global rank');
  }).first();
  if (rankEl.length) {
    const rankText = rankEl.text();
    const rankMatch = rankText.match(/(\d+[\d,]*)/);
    if (rankMatch) {
      globalRank = rankMatch[1].replace(/,/g, '');
    }
  }

  const totalSolved = parseTotalSolved($, html);
  if (totalSolved === null) {
    // Bot check pages and layout changes also answer 200. Failing keeps the stored stats.
    logger.error('CodeChef solved count not found in page', { username, url });
    throw new Error('Could not read the solved count from the CodeChef profile page');
  }

  if (!globalRank || globalRank === '0' || globalRank === '') {
    const globalMatch = html.match(/Global Rank:\s*(\d+)/i);
    if (globalMatch) globalRank = globalMatch[1];
  }

  let countryRank: string | null = null;
  const countryMatch = html.match(/Country Rank:\s*(\d+)/i);
  if (countryMatch) countryRank = countryMatch[1];

  // Parse stars (e.g., 1★, 2★)
  let stars: string | null = null;
  const starsEl = $('.rating-star').first();
  if (starsEl.length) {
    stars = starsEl.text().trim();
  }

  logger.info('CodeChef stats parsed', {
    username,
    totalSolved,
    rating,
    highestRating,
    globalRank,
    stars,
  });

  return {
    username,
    totalSolved,
    easySolved: 0,
    mediumSolved: 0,
    hardSolved: 0,
    rating,
    rank: stars || globalRank, // Prefer star rating as display rank for CodeChef
    totalContests: 0,
    rawData: {
      rating,
      highestRating,
      globalRank,
      countryRank,
      stars,
      totalSolved,
      scrapedAt: new Date().toISOString(),
    },
  };
}

/** Returns null when the page has no readable solved count. A real zero returns 0. */
function parseTotalSolved($: cheerio.CheerioAPI, html: string): number | null {
  // "Total Problems Solved" is the authoritative metric, so it wins over any selector.
  const total = html.match(/Total Problems Solved\s*:?\s*(\d[\d,]*)/i);
  if (total) return parseInt(total[1].replace(/,/g, ''), 10);

  // Older layouts. The section also holds unrelated headings such as "Problems Authored (216)",
  // so only a number that follows the word "Solved" counts.
  for (const element of $('section.problems-solved h5, .problems-solved .heading').toArray()) {
    const match = $(element).text().match(/Solved\D*(\d[\d,]*)/i);
    if (match) return parseInt(match[1].replace(/,/g, ''), 10);
  }

  return null;
}
