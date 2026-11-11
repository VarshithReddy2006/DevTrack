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

  // Parse total solved problems - selector: section.problems-solved h5
  let totalSolved = 0;
  const problemsSolvedEl = $('section.problems-solved h5').first();
  if (problemsSolvedEl.length) {
    const problemsText = problemsSolvedEl.text();
    // Text example: "Total Problems Solved: 277"
    const match = problemsText.match(/(\d+[\d,]*)/);
    if (match) {
      const parsed = parseInt(match[1].replace(/,/g, ''), 10);
      if (!isNaN(parsed)) {
        totalSolved = parsed;
      }
    }
  }

  // Fallback: also check for .problems-solved .heading
  if (totalSolved === 0) {
    const headingEl = $('.problems-solved .heading').first();
    if (headingEl.length) {
      const headingText = headingEl.text();
      const match = headingText.match(/(\d+[\d,]*)/);
      if (match) {
        const parsed = parseInt(match[1].replace(/,/g, ''), 10);
        if (!isNaN(parsed)) {
          totalSolved = parsed;
        }
      }
    }
  }

  // Final Regex Fallback (Robust Parsing)
  // ALWAYS prefer "Total Problems Solved" text if present, as it's the authoritative metric
  const solvedMatch = html.match(/Total Problems Solved\s*:?\s*([\d,]+)/i);
  if (solvedMatch) {
    const parsed = parseInt(solvedMatch[1].replace(/,/g, ''), 10);
    if (!isNaN(parsed) && parsed > 0) {
      totalSolved = parsed;
    }
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

  // Return empty state if no data found (user might exist but have no activity)
  if (rating === null && totalSolved === 0) {
    logger.warn('CodeChef user exists but no stats found - possible private profile or new user', { username });
  }

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
