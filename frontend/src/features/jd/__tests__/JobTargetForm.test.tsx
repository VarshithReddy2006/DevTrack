import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { JobTargetForm } from '../components/JobTargetForm';

afterEach(cleanup);
const longText = 'Build reliable APIs. '.repeat(34).trim();
function mount(onSubmit = vi.fn().mockResolvedValue(undefined), onClose = vi.fn()) {
  render(<JobTargetForm resumeProfileId="resume-1" onSubmit={onSubmit} onClose={onClose} />);
  return { onSubmit, onClose };
}

it('validates live and previews the actual hostname without loading remote images', async () => {
  const { onSubmit } = mount();
  const input = screen.getByLabelText('Posting URL');
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: 'http://127.1/' } });
  expect(screen.getByRole('alert')).toHaveTextContent('Enter a public HTTP or HTTPS');
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(screen.queryByText(/Posting domain/)).toBeNull();
  fireEvent.submit(screen.getByRole('form'));
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: ' https://jobs.lever.co/company/role?source=job ' } });
  expect(screen.getByText('jobs.lever.co')).toBeInTheDocument();
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.submit(screen.getByRole('form'));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ resumeProfileId: 'resume-1', jdUrl: 'https://jobs.lever.co/company/role?source=job' }));
});

it('supports keyboard tabs, preserves mode drafts, and enforces the text word count', async () => {
  const { onSubmit } = mount();
  fireEvent.change(screen.getByLabelText('Posting URL'), { target: { value: 'https://boards.greenhouse.io/team' } });
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Import via URL' }), { key: 'ArrowRight' });
  const textTab = screen.getByRole('tab', { name: 'Paste Job Description' });
  expect(textTab).toHaveAttribute('aria-selected', 'true');
  expect(textTab).toHaveFocus();
  expect(document.getElementById(textTab.getAttribute('aria-controls')!)).toBe(screen.getByRole('tabpanel'));
  fireEvent.change(screen.getByLabelText('Job description'), { target: { value: 'word '.repeat(99) } });
  fireEvent.submit(screen.getByRole('form'));
  expect(screen.getByRole('alert')).toHaveTextContent('at least 100 words');
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Job description'), { target: { value: ` ${longText} ` } });
  fireEvent.keyDown(textTab, { key: 'Home' });
  expect(screen.getByLabelText('Posting URL')).toHaveValue('https://boards.greenhouse.io/team');
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Import via URL' }), { key: 'End' });
  expect(screen.getByLabelText('Job description')).toHaveValue(` ${longText} `);
  fireEvent.submit(screen.getByRole('form'));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ resumeProfileId: 'resume-1', jdText: longText }));
});

it('locks repeated submissions, edits and dismissal, and preserves the draft after failure for retry', async () => {
  let reject!: (error: Error) => void;
  const onSubmit = vi.fn().mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; })).mockResolvedValue(undefined);
  const { onClose } = mount(onSubmit);
  fireEvent.change(screen.getByLabelText('Posting URL'), { target: { value: 'https://jobs.lever.co/company/role' } });
  fireEvent.submit(screen.getByRole('form'));
  fireEvent.submit(screen.getByRole('form'));
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Submitting…' })).toBeDisabled();
  expect(screen.getByLabelText('Posting URL')).toBeDisabled();
  expect(screen.getByRole('tab', { name: 'Paste Job Description' })).toBeDisabled();
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => reject(new Error('Submission failed. Try again.')));
  expect(screen.getByRole('alert')).toHaveTextContent('Submission failed. Try again.');
  expect(screen.getByLabelText('Posting URL')).toHaveValue('https://jobs.lever.co/company/role');
  fireEvent.submit(screen.getByRole('form'));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
});

it('traps focus and returns it to the opener on Escape; closing clears the draft', async () => {
  function Dialog() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Open form</button>{open && <JobTargetForm resumeProfileId="resume-1" onClose={() => setOpen(false)} onSubmit={vi.fn()} />}</>;
  }
  render(<Dialog />);
  const opener = screen.getByRole('button', { name: 'Open form' });
  opener.focus();
  fireEvent.click(opener);
  fireEvent.change(screen.getByLabelText('Posting URL'), { target: { value: 'https://jobs.lever.co/role' } });
  const submit = screen.getByRole('button', { name: 'Analyze job posting' });
  submit.focus();
  fireEvent.keyDown(submit, { key: 'Tab' });
  expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
  expect(submit).toHaveFocus();
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(opener).toHaveFocus();
  fireEvent.click(opener);
  expect(screen.getByLabelText('Posting URL')).toHaveValue('');
});
