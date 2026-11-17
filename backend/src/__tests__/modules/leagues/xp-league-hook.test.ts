// The XP processor must hand every committed, positive award to the league score queue and nothing else.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

const enqueue = vi.hoisted(() => vi.fn());
vi.mock('../../../modules/leagues/workers/leagueScore.worker.js', () => ({ enqueueLeagueScore: enqueue }));

import { processXpEvent } from '../../../modules/xp/processor.js';

const userId = () => new Types.ObjectId().toString();

beforeEach(() => { enqueue.mockReset().mockResolvedValue(undefined); });

describe('XP processor -> league score queue', () => {
  it('enqueues the ledger-backed amount once, and not again for a duplicate event', async () => {
    const id = userId();
    const first = await processXpEvent({ userId: id, sourceType: 'dsa_accepted', sourceId: 'sub-1', difficulty: 'hard' });
    await processXpEvent({ userId: id, sourceType: 'dsa_accepted', sourceId: 'sub-1', difficulty: 'hard' });

    expect(first.awarded).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
      userId: id, sourceType: 'dsa_accepted', sourceId: 'sub-1', xpAwarded: first.xpAwarded,
      occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), requestId: undefined,
    });
  });

  it('does not enqueue an award worth 0 XP', async () => {
    const result = await processXpEvent({ userId: userId(), sourceType: 'sync_completed', sourceId: 'sync-0', metadata: { deltaSolved: 0 } });
    expect(result.xpAwarded).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does not enqueue a focus session that does not qualify (no completed session means 0 XP)', async () => {
    const result = await processXpEvent({ userId: userId(), sourceType: 'focus_session', sourceId: `focus_${new Types.ObjectId()}` });
    expect(result.awarded).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('a failing enqueue never fails the XP award', async () => {
    enqueue.mockRejectedValue(new Error('redis down'));
    const result = await processXpEvent({ userId: userId(), sourceType: 'dsa_accepted', sourceId: 'sub-2', difficulty: 'easy' });
    expect(result.awarded).toBe(true);
  });
});
