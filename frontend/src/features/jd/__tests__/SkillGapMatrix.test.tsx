import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillGapMatrix, type SkillGapMatrixProps } from '../components/SkillGapMatrix';
import { SKILL_CATEGORIES, type ComparedSkill, type MissingSkill, type StudyPlanSkillAction } from '../skillGap.types';

afterEach(cleanup);
function skills(): ComparedSkill[] {
  return [
    { id: 'ts', name: 'TypeScript', category: 'Languages', requirement: 'required', status: 'matched', evidence: [{ source: 'resume', verified: false }, { source: 'github', verified: true }] },
    { id: 'react', name: 'React', category: 'frameworks', requirement: 'preferred', status: 'matched', evidence: [{ source: 'resume', verified: false }] },
    { id: 'algorithms', name: 'Algorithms', category: 'System Design', requirement: 'preferred', status: 'matched', evidence: [{ source: 'dsa', verified: true }] },
    { id: 'docker', name: 'Docker', category: 'cloud_devops', requirement: 'required', status: 'missing' },
    { id: 'postgres', name: 'PostgreSQL', category: 'database', requirement: 'preferred', status: 'missing' },
    { id: 'domain', name: 'Domain knowledge', category: 'Industry expertise', requirement: 'unknown', status: 'missing' },
  ];
}
function mount(overrides: Partial<SkillGapMatrixProps> = {}) {
  const onAddToStudyPlan = vi.fn<(action: StudyPlanSkillAction) => Promise<void>>().mockResolvedValue(undefined);
  const props = { jobTargetId: 'target-1', skills: skills(), onAddToStudyPlan, ...overrides };
  return { ...render(<SkillGapMatrix {...props} />), props, onAddToStudyPlan };
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const search = (value: string) => fireEvent.change(screen.getByRole('searchbox', { name: 'Search skills' }), { target: { value } });

describe('SkillGapMatrix: comparison and evidence', () => {
  it('groups matched and missing skills into the five named categories and an honest Other fallback', () => {
    mount();
    const matrix = screen.getByRole('region', { name: 'Skill gap matrix' });
    const matched = within(matrix).getByRole('region', { name: /Matched skills/ });
    const missing = within(matrix).getByRole('region', { name: /Missing skills/ });
    expect(within(matched).getByText('TypeScript')).toBeInTheDocument();
    expect(within(missing).queryByText('TypeScript')).not.toBeInTheDocument();
    expect(within(missing).getByText('Docker')).toBeInTheDocument();
    for (const category of SKILL_CATEGORIES) expect(screen.getByRole('heading', { name: category })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Missing skills: Other' })).getByText('Domain knowledge')).toBeInTheDocument();
  });
  it('distinguishes required, preferred and unknown priorities without inventing a requirement', () => {
    mount();
    expect(within(screen.getByRole('list', { name: 'Missing skills: Cloud & DevOps' })).getByText('Required')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Missing skills: Databases' })).getByText('Preferred')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Missing skills: Other' })).getByText('Priority not provided')).toBeInTheDocument();
  });
  it('shows sources and reuses verification badges only from explicit verified evidence', () => {
    mount();
    const language = screen.getByRole('list', { name: 'Matched skills: Languages' });
    expect(within(language).getByLabelText('Verified evidence')).toBeInTheDocument();
    expect(within(language).getByText('Found in: Resume (unverified), GitHub (verified)')).toBeInTheDocument();
    const framework = screen.getByRole('list', { name: 'Matched skills: Frameworks' });
    expect(within(framework).getByLabelText('Unverified evidence')).toBeInTheDocument();
    expect(within(framework).queryByLabelText('Verified evidence')).not.toBeInTheDocument();
    expect(screen.getByText('Found in: DSA (verified)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cryptographic proof/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add TypeScript/ })).not.toBeInTheDocument();
  });
  it('handles missing provenance without a verified badge', () => {
    mount({ skills: [{ ...(skills()[0]), status: 'matched', evidence: [] }] });
    expect(screen.getByText('Sources not provided.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Verified evidence')).not.toBeInTheDocument();
    expect(screen.getByText('No missing skills reported in this view.')).toBeInTheDocument();
  });
  it('does not mutate frozen source arrays or skill objects while grouping and filtering', () => {
    const data = Object.freeze(skills().map(skill => Object.freeze(skill)));
    mount({ skills: data }); search('DATABASES');
    expect(screen.getByText('PostgreSQL')).toBeInTheDocument();
    expect(data.map(skill => skill.id)).toEqual(['ts', 'react', 'algorithms', 'docker', 'postgres', 'domain']);
  });
  it('places unknown and prototype-like category names under Other', () => {
    mount({ skills: [{ ...(skills()[3] as MissingSkill), category: '__proto__' }] });
    expect(screen.getByRole('list', { name: 'Missing skills: Other' })).toBeInTheDocument();
  });
});

describe('SkillGapMatrix: filtering and empty states', () => {
  it.each(['  dOcKeR  ', 'Ｄｏｃｋｅｒ', 'Cloud & DevOps'])('filters by skill or category for %j', query => {
    mount(); search(query);
    expect(screen.getByText('Docker')).toBeInTheDocument();
    expect(screen.queryByText('TypeScript')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 1 of 6 skills')).toBeInTheDocument();
    expect(screen.getByText('No matched skills reported in this view.')).toBeInTheDocument();
  });
  it('provides a clear search action and restores the complete comparison', () => {
    mount(); search('unknown skill');
    expect(screen.getByText('No skills match your search.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByText('TypeScript')).toBeInTheDocument();
    expect(screen.getByText('Showing 6 of 6 skills')).toBeInTheDocument();
  });
  it('renders a report with no skill data without fabricating matches or actions', () => {
    const { onAddToStudyPlan } = mount({ skills: [] });
    expect(screen.getByText('No skill comparison available yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(onAddToStudyPlan).not.toHaveBeenCalled();
  });
  it('supports multiple instances with independent labels and search state', () => {
    mount(); mount({ jobTargetId: 'target-2' });
    const inputs = screen.getAllByRole('searchbox', { name: 'Search skills' });
    expect(inputs[0].id).not.toBe(inputs[1].id);
    fireEvent.change(inputs[0], { target: { value: 'Docker' } });
    expect(inputs[1]).toHaveValue('');
  });
});

describe('SkillGapMatrix: study-plan actions', () => {
  it('emits the target identity and original skill payload and acknowledges success only after persistence', async () => {
    const pending = deferred();
    const onAddToStudyPlan = vi.fn<(action: StudyPlanSkillAction) => Promise<void>>().mockReturnValue(pending.promise);
    const data = skills(); mount({ skills: data, onAddToStudyPlan });
    fireEvent.click(screen.getByRole('button', { name: 'Add Docker to study plan' }));
    expect(onAddToStudyPlan).toHaveBeenCalledExactlyOnceWith({ jobTargetId: 'target-1', skill: data[3] });
    expect(screen.getByRole('button', { name: 'Add Docker to study plan' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add Docker to study plan' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('button', { name: 'Docker added to study plan' })).not.toBeInTheDocument();
    await act(async () => pending.resolve());
    expect(screen.getByRole('button', { name: 'Docker added to study plan' })).toBeDisabled();
    expect(screen.getByText('Docker added to study plan.')).toBeInTheDocument();
  });
  it('prevents duplicate submissions while a pending row is filtered out and restored', async () => {
    const pending = deferred();
    const onAddToStudyPlan = vi.fn<(action: StudyPlanSkillAction) => Promise<void>>().mockReturnValue(pending.promise);
    mount({ onAddToStudyPlan });
    fireEvent.click(screen.getByRole('button', { name: 'Add Docker to study plan' }));
    search('TypeScript'); search('');
    const button = screen.getByRole('button', { name: 'Add Docker to study plan' });
    expect(button).toBeDisabled(); fireEvent.click(button);
    expect(onAddToStudyPlan).toHaveBeenCalledOnce();
    await act(async () => pending.resolve());
  });
  it('shows an actionable error and permits retry after a rejected callback', async () => {
    const onAddToStudyPlan = vi.fn<(action: StudyPlanSkillAction) => Promise<void>>()
      .mockRejectedValueOnce(new Error('network')).mockResolvedValue(undefined);
    mount({ onAddToStudyPlan });
    fireEvent.click(screen.getByRole('button', { name: 'Add Docker to study plan' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t add Docker. Try again.');
    expect(screen.getByRole('button', { name: 'Add Docker to study plan' })).toHaveAccessibleDescription('Couldn’t add Docker. Try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Add Docker to study plan' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Docker added to study plan' })).toBeDisabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onAddToStudyPlan).toHaveBeenCalledTimes(2);
  });
  it('handles a synchronous adapter exception without claiming success', async () => {
    mount({ onAddToStudyPlan: () => { throw new Error('adapter failed'); } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Docker to study plan' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Docker added to study plan.')).not.toBeInTheDocument();
  });
  it('keeps independent skills actionable and respects an existing study-plan entry', async () => {
    const data = skills(); (data[4] as MissingSkill).inStudyPlan = true;
    const { onAddToStudyPlan } = mount({ skills: data });
    expect(screen.getByRole('button', { name: 'PostgreSQL added to study plan' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Add Docker to study plan' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Docker added to study plan' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Add Domain knowledge to study plan' })).toBeEnabled();
    expect(onAddToStudyPlan).toHaveBeenCalledOnce();
  });
  it('resets search and action state for another target and ignores the old pending result', async () => {
    const pending = deferred();
    const { props, rerender } = mount({ onAddToStudyPlan: () => pending.promise });
    fireEvent.click(screen.getByRole('button', { name: 'Add Docker to study plan' }));
    search('Docker');
    rerender(<SkillGapMatrix {...props} jobTargetId="target-2" onAddToStudyPlan={async () => {}} />);
    expect(screen.getByRole('searchbox')).toHaveValue('');
    await act(async () => pending.resolve());
    expect(screen.getByRole('button', { name: 'Add Docker to study plan' })).toBeEnabled();
    expect(screen.queryByText('Docker added to study plan.')).not.toBeInTheDocument();
  });
});
