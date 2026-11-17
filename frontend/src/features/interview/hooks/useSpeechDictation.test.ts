// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AnswerComposer } from '../components/AnswerComposer';
import { useSpeechDictation } from './useSpeechDictation';

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
class FakeRecognition {
  static instance: FakeRecognition;
  onresult: ((event: { resultIndex: number; results: RecognitionResult[] }) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();

  constructor() {
    FakeRecognition.instance = this;
  }
}

function result(transcript: string, isFinal = true): RecognitionResult {
  return { isFinal, 0: { transcript } };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('falls back to typing when there is no speech recognition API', () => {
  vi.stubGlobal('SpeechRecognition', undefined);
  vi.stubGlobal('webkitSpeechRecognition', undefined);
  const transcripts = vi.fn();
  const { result: dictation } = renderHook(() => useSpeechDictation(transcripts));
  expect(dictation.current.unavailableReason).toMatch(/unavailable in this browser/);
  act(() => dictation.current.start());
  expect(dictation.current.isListening).toBe(false);
  expect(transcripts).not.toHaveBeenCalled();
});

it('accepts finalized phrases from the prefixed API and releases the microphone on unmount', () => {
  vi.stubGlobal('SpeechRecognition', undefined);
  vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
  const transcripts = vi.fn();
  const { result: dictation, unmount } = renderHook(() => useSpeechDictation(transcripts));
  act(() => dictation.current.start());
  const recognition = FakeRecognition.instance;
  expect(dictation.current.isListening).toBe(true);
  expect(recognition.start).toHaveBeenCalledOnce();

  act(() => {
    recognition.onresult?.({ resultIndex: 0, results: [result('Use a queue'), result('Maybe', false)] });
    recognition.onresult?.({ resultIndex: 1, results: [result('Use a queue'), result('with retry limits')] });
  });
  expect(transcripts.mock.calls).toEqual([['Use a queue'], ['with retry limits']]);
  unmount();
  expect(recognition.abort).toHaveBeenCalledOnce();
});

it('disables dictation after microphone access is denied', () => {
  vi.stubGlobal('SpeechRecognition', FakeRecognition);
  const { result: dictation } = renderHook(() => useSpeechDictation(vi.fn()));
  act(() => dictation.current.start());
  act(() => FakeRecognition.instance.onerror?.({ error: 'not-allowed' }));
  expect(dictation.current.isListening).toBe(false);
  expect(dictation.current.unavailableReason).toMatch(/Microphone access is blocked/);
});

it('appends recognized speech to the typed answer within the character limit', () => {
  vi.stubGlobal('SpeechRecognition', FakeRecognition);
  render(createElement(AnswerComposer, { pending: false, onAnswer: vi.fn() }));
  const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Your answer' });
  fireEvent.change(input, { target: { value: 'I would' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start dictation' }));
  act(() => FakeRecognition.instance.onresult?.({ resultIndex: 0, results: [result('use a queue')] }));
  expect(input.value).toBe('I would use a queue');
  act(() => FakeRecognition.instance.onresult?.({
    resultIndex: 1, results: [result('use a queue'), result('x'.repeat(8_001))],
  }));
  expect(input.value).toHaveLength(8_000);
});
