import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Flashcard } from './Flashcard';
import type { RevisionCard } from '../../../services/revisionService';

afterEach(cleanup);

const card: RevisionCard = {
  _id: 'card1', problemKey: 'leetcode:two-sum', title: 'Two Sum',
  difficulty: 'easy', tags: ['Array'], reviewSeq: 0, repetitions: 0,
  easeFactor: 2.5, intervalDays: 1, dueAt: '2026-11-16T00:00:00.000Z',
  notes: 'Intuition: Use a complement map.\nApproach: Scan once.\nKey Code Line: map.set(target - value, index)',
};

describe('Flashcard', () => {
  it('reveals labelled notes in order without showing later hints early', () => {
    render(<Flashcard card={card} />);
    expect(screen.getByText('Two Sum')).toBeTruthy();
    expect(screen.queryByText('Scan once.')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Reveal' })[0]);
    expect(screen.getByText('Use a complement map.')).toBeTruthy();
    expect(screen.queryByText('Scan once.')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Reveal' })[0]);
    expect(screen.getByText('Scan once.')).toBeTruthy();
    expect(screen.queryByText('map.set(target - value, index)')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
    expect(screen.getByText('map.set(target - value, index)')).toBeTruthy();
  });

  it('does not fabricate hints when only free-form notes are present', () => {
    render(<Flashcard card={{ ...card, notes: 'Remember the hash map.' }} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Reveal' })[0]);
    expect(screen.getByText('No hint saved for this stage.')).toBeTruthy();
    expect(screen.queryByText('Remember the hash map.')).toBeNull();
  });
});
