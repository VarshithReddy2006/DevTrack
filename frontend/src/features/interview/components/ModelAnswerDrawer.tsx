import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import { Drawer } from '../../../components/ui/Drawer';
import './modelAnswer.css';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('java', java);
hljs.registerLanguage('cpp', cpp);

// Only explicit fenced languages are highlighted. React escapes prose and unknown
// languages; highlight.js escapes source code before returning its markup.
function AnswerText({ text }: { text: string }) {
  return text.split(/(```[^\n]*\n[\s\S]*?```)/g).map((part, index) => {
    const fence = /^```([^\n]*)\n([\s\S]*?)```$/.exec(part);
    if (!fence) return <p key={index} className="whitespace-pre-wrap break-words">{part}</p>;
    const language = fence[1].trim().toLowerCase();
    const code = fence[2];
    return <pre key={index} className="model-answer-code overflow-x-auto rounded-lg bg-slate-900 p-4 text-sm text-slate-100" tabIndex={0} aria-label={`${language || 'Plain text'} code`}>
      {hljs.getLanguage(language)
        ? <code dangerouslySetInnerHTML={{ __html: hljs.highlight(code, { language, ignoreIllegals: true }).value }} />
        : <code>{code}</code>}
    </pre>;
  });
}

export function ModelAnswerDrawer({ open, onClose, modelAnswer, optimalApproach }: {
  open: boolean; onClose: () => void; modelAnswer: string; optimalApproach: string;
}) {
  return <Drawer open={open} onClose={onClose} title="Model answer" className="text-slate-100 sm:max-w-2xl">
    <div className="min-w-0 space-y-6 p-5">
      <p className="text-sm text-slate-300">AI-generated reference material. Code has not been executed or verified.</p>
      <section className="space-y-3" aria-label="Reference answer"><h3 className="font-semibold">Reference answer</h3><AnswerText text={modelAnswer} /></section>
      <section className="space-y-3" aria-label="Optimal approach"><h3 className="font-semibold">Optimal approach and complexity</h3><AnswerText text={optimalApproach} /></section>
    </div>
  </Drawer>;
}
