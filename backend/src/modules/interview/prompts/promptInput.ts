// src/modules/interview/prompts/promptInput.ts
//
// Candidate answers and earlier model replies are untrusted text. Before they go into a
// prompt they are length-capped, run through the shared prompt safety filters and fenced in
// a tag the model is told to treat as data. Anything inside that looks like our own fence
// tags is defused so an answer cannot close the block and add instructions after it.
import { PromptSafetyLayer } from '../../ai/safety/PromptSafetyLayer.js';

/** Same cap the studio UI puts on a single answer. */
export const MAX_ANSWER_CHARS = 8_000;

export function cleanUntrustedText(text: string, maxChars = MAX_ANSWER_CHARS): string {
  const capped = text.length > maxChars ? text.slice(0, maxChars) : text;
  return PromptSafetyLayer.sanitizePrompt(capped)
    .replace(/<\s*\/?\s*(candidate_answer|interviewer_reply|evaluator_notes|transcript)[^>]*>/gi, '[tag removed]')
    .trim();
}

export function fence(tag: string, text: string): string {
  return `<${tag}>\n${text}\n</${tag}>`;
}
