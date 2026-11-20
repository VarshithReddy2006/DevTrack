import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LiveAudioWaveform } from '../components/LiveAudioWaveform';
import { AnswerComposer } from '../components/AnswerComposer';

let amplitude = 0, frequency = 0, reduced = false, nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
const paint = { clearRect: vi.fn(), fillRect: vi.fn(), fillStyle: '' };
const getUserMedia = vi.fn();
const contexts: FakeContext[] = [];
class FakeContext extends EventTarget {
  state: AudioContextState = 'running';
  analyser = { fftSize: 512, frequencyBinCount: 256, smoothingTimeConstant: 0,
    getByteFrequencyData: (data: Uint8Array) => data.fill(frequency),
    getFloatTimeDomainData: (data: Float32Array) => data.fill(amplitude), disconnect: vi.fn() };
  source = { connect: vi.fn(), disconnect: vi.fn() };
  createAnalyser = vi.fn(() => this.analyser);
  createMediaStreamSource = vi.fn(() => this.source);
  close = vi.fn(async () => { this.state = 'closed'; });
  resume = vi.fn(async () => { this.state = 'running'; this.dispatchEvent(new Event('statechange')); });
  constructor() { super(); contexts.push(this); }
}
function microphone() {
  const track = Object.assign(new EventTarget(), { readyState: 'live', stop: vi.fn() });
  track.stop.mockImplementation(() => { track.readyState = 'ended'; });
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  return { stream, track };
}
async function tick(now: number) {
  await act(async () => {
    const callbacks = [...frames.values()]; frames.clear();
    callbacks.forEach(callback => callback(now));
  });
}
beforeEach(() => {
  amplitude = 0; frequency = 0; reduced = false; nextFrame = 0; frames.clear(); contexts.length = 0;
  getUserMedia.mockReset(); paint.clearRect.mockClear(); paint.fillRect.mockClear();
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  vi.stubGlobal('matchMedia', () => ({ get matches() { return reduced; } }));
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(paint as unknown as CanvasRenderingContext2D);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('captures nothing until activated and releases only its own stream when stopped', async () => {
  const owned = microphone(); getUserMedia.mockResolvedValue(owned.stream);
  const view = render(<LiveAudioWaveform active={false} />);
  expect(getUserMedia).not.toHaveBeenCalled(); expect(contexts).toHaveLength(0);
  view.rerender(<LiveAudioWaveform active />);
  await screen.findByText(/Microphone active/);
  expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true });
  expect(contexts[0].source.connect).toHaveBeenCalledExactlyOnceWith(contexts[0].analyser);
  view.rerender(<LiveAudioWaveform active={false} />);
  expect(owned.track.stop).toHaveBeenCalledTimes(1); expect(contexts[0].close).toHaveBeenCalledTimes(1);
  expect(contexts[0].source.disconnect).toHaveBeenCalledTimes(1); expect(frames.size).toBe(0);
  view.unmount(); expect(owned.track.stop).toHaveBeenCalledTimes(1);
});
it('never stops borrowed tracks, including when the supplied stream changes', async () => {
  const first = microphone(), second = microphone();
  const view = render(<LiveAudioWaveform active stream={first.stream} />); await screen.findByText(/Microphone active/);
  view.rerender(<LiveAudioWaveform active stream={second.stream} />); await waitFor(() => expect(contexts).toHaveLength(2));
  expect(contexts[0].close).toHaveBeenCalledTimes(1); expect(first.track.stop).not.toHaveBeenCalled();
  view.unmount(); expect(second.track.stop).not.toHaveBeenCalled(); expect(contexts[1].close).toHaveBeenCalledTimes(1);
  expect(getUserMedia).not.toHaveBeenCalled(); expect(frames.size).toBe(0);
});
it('stops a late permission response after unmount without creating an audio context', async () => {
  const owned = microphone(); let resolve!: (stream: MediaStream) => void;
  getUserMedia.mockReturnValue(new Promise<MediaStream>(done => { resolve = done; }));
  const view = render(<LiveAudioWaveform active />); view.unmount();
  await act(async () => { resolve(owned.stream); });
  expect(owned.track.stop).toHaveBeenCalledTimes(1); expect(contexts).toHaveLength(0); expect(frames.size).toBe(0);
});
it('handles StrictMode cleanup and a superseded permission request without leaking either stream', async () => {
  const first = microphone(), second = microphone(); const resolvers: ((stream: MediaStream) => void)[] = [];
  getUserMedia.mockImplementation(() => new Promise<MediaStream>(resolve => resolvers.push(resolve)));
  const view = render(<StrictMode><LiveAudioWaveform active /></StrictMode>);
  expect(resolvers).toHaveLength(2);
  await act(async () => { resolvers[1](second.stream); resolvers[0](first.stream); });
  await screen.findByText(/Microphone active/);
  expect(first.track.stop).toHaveBeenCalledTimes(1); expect(second.track.stop).not.toHaveBeenCalled(); expect(contexts).toHaveLength(1);
  view.unmount(); expect(second.track.stop).toHaveBeenCalledTimes(1); expect(frames.size).toBe(0);
});
it('paints 32 bounded frequency bars from the sampled microphone signal', async () => {
  getUserMedia.mockResolvedValue(microphone().stream); render(<LiveAudioWaveform active />); await screen.findByText(/Microphone active/);
  amplitude = 0.1; frequency = 255; await tick(0);
  expect(paint.fillRect).toHaveBeenCalledTimes(32);
  for (const [x, y, width, height] of paint.fillRect.mock.calls) {
    expect(x).toBeGreaterThanOrEqual(0); expect(x + width).toBeLessThanOrEqual(640);
    expect(y).toBeGreaterThanOrEqual(0); expect(y + height).toBeLessThanOrEqual(80); expect(height).toBe(68);
  }
  expect(screen.getByRole('img', { name: /32 frequency bars/ })).toBeInTheDocument();
});
it('uses RMS dBFS and warns only after more than five continuous seconds below -50 dBFS', async () => {
  getUserMedia.mockResolvedValue(microphone().stream); render(<LiveAudioWaveform active />); await screen.findByText(/Microphone active/);
  amplitude = 0.001; await tick(0); await tick(5000);
  expect(screen.queryByText(/Very low microphone/)).not.toBeInTheDocument();
  await tick(5001); expect(screen.getByText(/Very low microphone/)).toBeInTheDocument();
  amplitude = 0.01; await tick(5100); expect(screen.queryByText(/Very low microphone/)).not.toBeInTheDocument();
  amplitude = 0.001; await tick(6000); await tick(11000); expect(screen.queryByText(/Very low microphone/)).not.toBeInTheDocument();
  await tick(11001); expect(screen.getByText(/Very low microphone/)).toBeInTheDocument();
});
it('cancels hidden-page animation and restarts the silence interval when visible', async () => {
  getUserMedia.mockResolvedValue(microphone().stream); render(<LiveAudioWaveform active />); await screen.findByText(/Microphone active/); await tick(0); await tick(4000);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); fireEvent(document, new Event('visibilitychange'));
  expect(frames.size).toBe(0);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false); fireEvent(document, new Event('visibilitychange'));
  await tick(20000); expect(screen.queryByText(/Very low microphone/)).not.toBeInTheDocument();
  await tick(25001); expect(screen.getByText(/Very low microphone/)).toBeInTheDocument();
});
it('disables the decorative idle ripple and limits painting to 10Hz for reduced motion', async () => {
  reduced = true; getUserMedia.mockResolvedValue(microphone().stream); render(<LiveAudioWaveform active />); await screen.findByText(/Microphone active/);
  await tick(0); await tick(16); await tick(100);
  expect(paint.fillRect).toHaveBeenCalledTimes(64);
  expect(paint.fillRect.mock.calls.every(call => call[3] === 3)).toBe(true);
});
it('shows a denied-permission error and retries only on a deliberate action', async () => {
  const owned = microphone(); getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError')).mockResolvedValueOnce(owned.stream);
  render(<LiveAudioWaveform active />); await screen.findByText(/Microphone access was denied/);
  expect(getUserMedia).toHaveBeenCalledTimes(1); fireEvent.click(screen.getByRole('button', { name: 'Retry audio monitor' }));
  await screen.findByText(/Microphone active/); expect(getUserMedia).toHaveBeenCalledTimes(2);
});
it('handles unsupported browsers and an already-ended borrowed stream without capture', async () => {
  vi.stubGlobal('AudioContext', undefined); const view = render(<LiveAudioWaveform active />);
  await screen.findByText(/Audio visualization is unavailable/); expect(getUserMedia).not.toHaveBeenCalled(); view.unmount();
  vi.stubGlobal('AudioContext', FakeContext); const borrowed = microphone(); borrowed.track.readyState = 'ended';
  render(<LiveAudioWaveform active stream={borrowed.stream} />); await screen.findByText(/No active microphone signal/);
  expect(borrowed.track.stop).not.toHaveBeenCalled(); expect(contexts).toHaveLength(0);
});
it('offers a user-gesture resume for a paused context and releases a disconnected microphone', async () => {
  const owned = microphone(); getUserMedia.mockResolvedValue(owned.stream); render(<LiveAudioWaveform active />); await screen.findByText(/Microphone active/);
  act(() => { contexts[0].state = 'suspended'; contexts[0].dispatchEvent(new Event('statechange')); });
  expect(frames.size).toBe(0); fireEvent.click(screen.getByRole('button', { name: 'Resume audio monitor' }));
  await screen.findByText(/Microphone active/); expect(frames.size).toBe(1);
  act(() => { owned.track.dispatchEvent(new Event('ended')); }); await screen.findByText(/Microphone disconnected/);
  expect(contexts[0].close).toHaveBeenCalledTimes(1); expect(owned.track.stop).toHaveBeenCalledTimes(1); expect(frames.size).toBe(0);
});
it('cleans up failed AudioContext initialization and can still retry', async () => {
  const owned = microphone(); getUserMedia.mockResolvedValue(owned.stream);
  vi.stubGlobal('AudioContext', class { constructor() { throw new Error('device failed'); } });
  render(<LiveAudioWaveform active />); await screen.findByText(/Could not start the audio monitor/);
  expect(owned.track.stop).toHaveBeenCalledTimes(1); expect(frames.size).toBe(0);
});
it('integrates with native dictation start/stop and submits the typed draft without leaking capture', async () => {
  const recognizers: { onend: (() => void) | null; stop: ReturnType<typeof vi.fn> }[] = [];
  class Recognition {
    onend = null; onerror = null; onresult = null;
    start = vi.fn(); stop = vi.fn(); abort = vi.fn();
    constructor() { recognizers.push(this); }
  }
  vi.stubGlobal('SpeechRecognition', Recognition);
  const first = microphone(), second = microphone(); getUserMedia.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
  const onAnswer = vi.fn(); render(<AnswerComposer pending={false} onAnswer={onAnswer} />);
  expect(getUserMedia).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Start dictation' })); await screen.findByText(/Microphone active/);
  fireEvent.click(screen.getByRole('button', { name: 'Stop dictation' }));
  expect(first.track.stop).toHaveBeenCalledTimes(1); expect(recognizers[0].stop).toHaveBeenCalledTimes(1);
  act(() => recognizers[0].onend?.()); fireEvent.click(screen.getByRole('button', { name: 'Start dictation' })); await screen.findByText(/Microphone active/);
  fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), { target: { value: 'My answer stays intact.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }));
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith('My answer stays intact.'); expect(second.track.stop).toHaveBeenCalledTimes(1); expect(frames.size).toBe(0);
});
