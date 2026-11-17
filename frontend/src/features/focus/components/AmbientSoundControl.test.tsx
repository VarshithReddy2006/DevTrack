import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AmbientSoundControl } from './AmbientSoundControl';

function mockAudio() {
  const makeNode = () => ({ connect: vi.fn((target: unknown) => target), disconnect: vi.fn() });
  const makeSource = () => ({ ...makeNode(), start: vi.fn(), stop: vi.fn() });
  const bufferSource = makeSource();
  const filter = { ...makeNode(), type: '', frequency: { value: 0 } };
  const output = { ...makeNode(), gain: { value: 0, setTargetAtTime: vi.fn() } };
  const gain = { ...makeNode(), gain: { value: 0 } };
  const oscillators: ReturnType<typeof makeSource>[] = [];
  const context = {
    state: 'suspended',
    sampleRate: 32,
    currentTime: 1,
    destination: makeNode(),
    createGain: vi.fn(() => gain).mockReturnValueOnce(output),
    createBuffer: vi.fn(() => ({ getChannelData: () => new Float32Array(128) })),
    createBufferSource: vi.fn(() => bufferSource),
    createBiquadFilter: vi.fn(() => filter),
    createOscillator: vi.fn(() => {
      const oscillator = { ...makeSource(), frequency: { value: 0 }, detune: { value: 0 } };
      oscillators.push(oscillator);
      return oscillator;
    }),
    resume: vi.fn(async () => { context.state = 'running'; }),
    suspend: vi.fn(async () => { context.state = 'suspended'; }),
    close: vi.fn(async () => { context.state = 'closed'; }),
  };

  const constructor = vi.fn(function () { return context; });
  vi.stubGlobal('AudioContext', constructor);
  return { context, constructor, bufferSource, filter, output, oscillators };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('unlocks on a preset click and plays only while the timer is running', async () => {
  const audio = mockAudio();
  const view = render(<AmbientSoundControl running={false} />);
  expect(audio.constructor).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Rain' }));
  expect(audio.constructor).toHaveBeenCalledOnce();
  expect(audio.filter.type).toBe('bandpass');
  expect(audio.bufferSource.connect).toHaveBeenCalledWith(audio.filter);
  expect(audio.bufferSource.start).toHaveBeenCalledOnce();
  expect(audio.output.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 1, 0.02);
  await waitFor(() => expect(audio.context.suspend).toHaveBeenCalledOnce());

  view.rerender(<AmbientSoundControl running />);
  await waitFor(() => expect(audio.context.state).toBe('running'));
  fireEvent.change(screen.getByRole('slider', { name: 'Volume' }), { target: { value: '50' } });
  expect(audio.output.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.09, 1, 0.02);

  view.rerender(<AmbientSoundControl running={false} />);
  await waitFor(() => expect(audio.context.state).toBe('suspended'));
  view.unmount();
  expect(audio.bufferSource.stop).toHaveBeenCalledOnce();
  expect(audio.filter.disconnect).toHaveBeenCalledOnce();
  expect(audio.context.close).toHaveBeenCalledOnce();
}, 15_000);

it('replaces the noise graph with oscillators and releases them when switched off', () => {
  const audio = mockAudio();
  render(<AmbientSoundControl running />);

  fireEvent.click(screen.getByRole('button', { name: 'White Noise' }));
  expect(audio.filter.type).toBe('lowpass');
  expect(audio.filter.connect).toHaveBeenCalledWith(audio.output);
  fireEvent.click(screen.getByRole('button', { name: 'Lo-Fi' }));
  expect(audio.bufferSource.stop).toHaveBeenCalledOnce();
  expect(audio.context.createOscillator).toHaveBeenCalledTimes(8);
  expect(audio.constructor).toHaveBeenCalledOnce();

  fireEvent.click(screen.getByRole('button', { name: 'Off' }));
  for (const oscillator of audio.oscillators) {
    expect(oscillator.start).toHaveBeenCalledOnce();
    expect(oscillator.stop).toHaveBeenCalledOnce();
    expect(oscillator.disconnect).toHaveBeenCalledOnce();
  }
  expect(audio.output.disconnect).toHaveBeenCalledOnce();
  expect(audio.context.close).toHaveBeenCalledOnce();
});
