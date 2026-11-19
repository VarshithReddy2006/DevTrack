import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { InterviewRubricCard } from '../components/InterviewRubricCard';
import { interviewRubricReportSchema, type InterviewRubricReport } from '../rubricReport';

afterEach(cleanup);

function report(score = 80): InterviewRubricReport {
  const dimension = () => ({ score, rationale: 'Explains the design trade-off.', citations: [{
    turnIndex: 1, source: 'answer' as const, quote: 'Use a map', explanation: 'Identifies a lookup structure.',
  }] });
  return {
    dimensions: { problemSolving: dimension(), communication: dimension(), codeCorrectness: dimension(), complexity: dimension() },
    overallScore: score, mode: 'ai', model: 'test-model', version: 'interview-rubric-v1',
    strengths: ['Clear reasoning'], improvements: ['Discuss memory use'],
    modelAnswer: 'Use a map.\n```javascript\nconst answer = "<script>alert(1)</script>";\n```',
    optimalApproach: 'Expected O(n) time and O(n) space.',
  };
}

describe('InterviewRubricCard', () => {
  it.each([[0, 'Lean No Hire'], [69, 'Lean No Hire'], [70, 'Hire'], [84, 'Hire'], [85, 'Strong Hire'], [100, 'Strong Hire']] as const)(
    'renders the practice recommendation at score %i', (score, recommendation) => {
      render(<InterviewRubricCard report={report(score)} />);
      expect(screen.getByText(recommendation)).toBeInTheDocument();
      expect(screen.getByLabelText(`Overall score: ${score} out of 100`)).toBeInTheDocument();
      expect(screen.getByText(/Practice recommendation derived/)).toBeInTheDocument();
    },
  );

  it('renders four accurate, named bars, rationale, feedback and source citations', () => {
    const data = report();
    data.dimensions.problemSolving.score = 100;
    data.dimensions.communication.score = 70;
    data.dimensions.codeCorrectness.score = 50;
    data.overallScore = 75;
    data.dimensions.codeCorrectness.citations[0].source = 'code';
    render(<InterviewRubricCard report={data} />);
    const bars = screen.getAllByRole('progressbar');
    expect(bars).toHaveLength(4);
    for (const [name, score] of [['Problem Solving', 100], ['Technical Communication', 70], ['Code Quality', 50], ['Complexity Optimization', 80]] as const) {
      const bar = screen.getByRole('progressbar', { name: new RegExp(name) });
      expect(bar).toHaveAttribute('aria-valuenow', String(score));
      expect(bar.firstElementChild).toHaveStyle({ width: `${score}%` });
      expect(bar).toHaveAccessibleDescription('Explains the design trade-off.');
    }
    expect(screen.getByText('Clear reasoning')).toBeInTheDocument();
    expect(screen.getByText('Discuss memory use')).toBeInTheDocument();
    expect(screen.getAllByText('Use a map')).toHaveLength(4);
    expect(screen.getByText(/Turn 2 · Submitted code/)).toBeInTheDocument();
  });

  it('opens highlighted reference code, traps keyboard focus, closes on Escape and restores focus', async () => {
    render(<InterviewRubricCard report={report()} />);
    const opener = screen.getByRole('button', { name: 'View Model Answer' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Model answer' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    expect(dialog.querySelector('.hljs-keyword')).toHaveTextContent('const');
    expect(dialog.querySelector('script')).toBeNull();
    expect(dialog.querySelector('code')).toHaveTextContent('<script>alert(1)</script>');
    expect(screen.getByText('Expected O(n) time and O(n) space.')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByLabelText('javascript code'));
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe('');
  });

  it('closes with its close button and can reopen', () => {
    render(<InterviewRubricCard report={report()} />);
    fireEvent.click(screen.getByRole('button', { name: 'View Model Answer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View Model Answer' }));
    expect(screen.getByRole('dialog', { name: 'Model answer' })).toBeInTheDocument();
  });

  it('shows missing strengths explicitly and escapes prose and unsupported code', () => {
    const data = report();
    data.strengths = [];
    data.modelAnswer = '<img src=x onerror=alert(1)>\n```unknown\n<svg onload=alert(1)>\n```';
    render(<InterviewRubricCard report={data} />);
    expect(screen.getByText('No feedback recorded.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View Model Answer' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('img, [onload], [onerror]')).toBeNull();
    expect(screen.getByLabelText('unknown code')).toHaveTextContent('<svg onload=alert(1)>');
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  });

  it.each(['javascript', 'typescript', 'python', 'java', 'cpp'])('highlights explicitly fenced %s code', language => {
    const data = report();
    data.modelAnswer = `\`\`\`${language}\nreturn 42;\n\`\`\``;
    render(<InterviewRubricCard report={data} />);
    fireEvent.click(screen.getByRole('button', { name: 'View Model Answer' }));
    expect(screen.getByLabelText(`${language} code`).querySelector('.hljs-keyword')).toHaveTextContent('return');
  });

  it('does not turn an unavailable fallback report into a zero competency score or hiring decision', () => {
    const data = report(0);
    data.mode = 'basic_mode';
    data.fallbackReason = 'ai_unavailable';
    for (const dimension of Object.values(data.dimensions)) dimension.citations = [];
    render(<InterviewRubricCard report={data} />);
    expect(screen.getByRole('status')).toHaveTextContent('Not evaluated');
    expect(screen.queryByText('Lean No Hire')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View Model Answer' })).not.toBeInTheDocument();
  });

  it.each(['mismatched mean', 'out of range', 'missing citation', 'wrong version'])('rejects %s without a misleading dashboard', scenario => {
    const data = report();
    if (scenario === 'mismatched mean') data.overallScore = 99;
    if (scenario === 'out of range') data.dimensions.problemSolving.score = 101;
    if (scenario === 'missing citation') data.dimensions.communication.citations = [];
    if (scenario === 'wrong version') Object.assign(data, { version: 'unknown' });
    expect(interviewRubricReportSchema.safeParse(data).success).toBe(false);
    render(<InterviewRubricCard report={data} />);
    expect(screen.getByRole('alert')).toHaveTextContent('invalid');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('updates from new report props without mutating the original data', () => {
    const data = report();
    const before = structuredClone(data);
    const { rerender } = render(<InterviewRubricCard report={data} />);
    rerender(<InterviewRubricCard report={report(90)} />);
    expect(screen.getByText('Strong Hire')).toBeInTheDocument();
    expect(data).toEqual(before);
  });
});
