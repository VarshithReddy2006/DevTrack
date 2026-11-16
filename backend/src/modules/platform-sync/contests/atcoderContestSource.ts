import * as cheerio from 'cheerio';
import { fetchWithTimeout } from '../../../shared/fetchWithTimeout.js';
import { circuitBreakers } from '../../../shared/circuit-breaker/circuitBreaker.js';
import { logger } from '../../../shared/logger.js';
import type { ContestPhase, ContestSource, UpcomingContest } from './ContestSource.js';

export class AtCoderContestSource implements ContestSource {
  readonly platform = 'atcoder' as const;

  async fetchUpcoming(signal?: AbortSignal): Promise<UpcomingContest[]> {
    return circuitBreakers.atcoder.execute(async () => {
      const url = 'https://atcoder.jp/contests/';
      const res = await fetchWithTimeout(url, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        timeoutMs: 12_000,
        signal,
      });

      if (!res.ok) {
        throw new Error(`AtCoder contests HTTP ${res.status}`);
      }

      const html = await res.text();
      const $ = cheerio.load(html);
      const now = Date.now();
      const upcoming: UpcomingContest[] = [];

      // Target upcoming and active contest tables
      const targetRows = $('#contest-table-upcoming tbody tr, #contest-table-action tbody tr');

      targetRows.each((_idx, el) => {
        const tds = $(el).find('td');
        if (tds.length < 2) return;

        // Parse Time (td 0)
        const timeCell = $(tds[0]);
        let timeStr = timeCell.find('a').text().trim() || timeCell.text().trim();
        // Time format on AtCoder: "2024-03-23 21:00:00+0900" or similar
        if (!timeStr) return;
        // If missing tz offset, AtCoder uses JST (+0900)
        if (!timeStr.includes('+') && !timeStr.includes('Z')) {
          timeStr = `${timeStr}+0900`;
        }
        const startTime = new Date(timeStr.replace(/\s+/, 'T'));
        if (Number.isNaN(startTime.getTime())) return;

        // Parse Contest Title & Link (td 1)
        const contestCell = $(tds[1]);
        const anchor = contestCell.find('a').last();
        const href = anchor.attr('href') || '';
        const match = href.match(/\/contests\/([^/?#]+)/);
        if (!match) return;

        const externalId = match[1];
        // Strip HTML, badge labels, and normalize whitespace
        const contestName = anchor.text().replace(/\s+/g, ' ').trim() || externalId;

        // Parse Duration (td 2)
        let durationSeconds = 100 * 60; // 100 min default
        if (tds.length >= 3) {
          const durationStr = $(tds[2]).text().trim();
          const parts = durationStr.split(':');
          if (parts.length === 2) {
            const h = parseInt(parts[0], 10);
            const m = parseInt(parts[1], 10);
            if (!Number.isNaN(h) && !Number.isNaN(m)) {
              durationSeconds = (h * 60 + m) * 60;
            }
          } else {
            const parsedMin = parseInt(durationStr, 10);
            if (!Number.isNaN(parsedMin)) {
              durationSeconds = parsedMin * 60;
            }
          }
        }

        const endTime = new Date(startTime.getTime() + durationSeconds * 1000);
        if (endTime.getTime() < now) return;

        const phase: ContestPhase = now < startTime.getTime() ? 'BEFORE' : 'CODING';

        upcoming.push({
          platform: this.platform,
          externalId,
          contestName,
          startTime,
          endTime,
          durationSeconds,
          url: `https://atcoder.jp/contests/${externalId}`,
          phase,
          kind: 'scheduled' as const,
          stale: false,
          fetchedAt: new Date(),
        });
      });

      upcoming.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
      logger.info(`[contest-source] AtCoder ingested ${upcoming.length} upcoming contests`);
      return upcoming;
    });
  }
}

export const atcoderContestSource = new AtCoderContestSource();
