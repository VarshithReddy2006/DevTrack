interface CommunicationArtifact {
  type: string;
  content: string;
  /** Total added and deleted lines, when available from PR metadata. */
  changedLines?: number;
}

const documentationSections = [
  /\b(overview|introduction|about)\b/i,
  /\b(architecture|design|system design)\b/i,
  /\b(setup|install(?:ation)?|getting started|quickstart)\b/i,
  /\b(configuration|environment|env)\b/i,
  /\b(api|usage|reference)\b/i,
];

const pullRequestSections = [
  /\b(summary|overview|description|what changed|changes)\b/i,
  /\b(context|motivation|background|why)\b/i,
  /\b(tests?|testing|validation|verification|repro(?:duction|duce)?)\b/i,
];

function tokenizeMarkdown(content: string) {
  const lines = content.split(/\r?\n/);
  const headings: { depth: number; title: string; hasContent: boolean }[] = [];
  const prose: string[] = [];
  let fence: string | undefined;
  let language = '';
  let codeBlocks = 0;
  let taggedBlocks = 0;
  let codeLines = 0;
  let diagram = false;
  let table = false;
  let proseLines = 0;
  let hasCode = false;
  let inComment = false;

  for (const [index, line] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = undefined;
      } else if (line.trim()) {
        codeLines++;
        if (!hasCode) {
          codeBlocks++;
          if (language) taggedBlocks++;
          if (language === 'mermaid') diagram = true;
          hasCode = true;
          const section = headings.at(-1);
          if (section) section.hasContent = true;
        }
      }
      continue;
    }

    // Template comments are hidden in Markdown. Inside fences they are code.
    const commentEnd = inComment ? line.indexOf('-->') : -1;
    if (inComment && commentEnd === -1) continue;
    inComment = false;
    const visible = line.slice(commentEnd === -1 ? 0 : commentEnd + 3).replace(/<!--.*?-->/g, '');
    const commentStart = visible.indexOf('<!--');
    if (commentStart !== -1) inComment = true;
    const text = commentStart === -1 ? visible : visible.slice(0, commentStart);

    const openingFence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (openingFence) {
      fence = openingFence[1];
      language = openingFence[2].trim().split(/\s+/, 1)[0].toLowerCase();
      hasCode = false;
      continue;
    }

    const heading = /^ {0,3}(#{1,6})[ \t]+(.+)$/.exec(text);
    if (heading) {
      headings.push({ depth: heading[1].length, title: heading[2].trim(), hasContent: false });
      continue;
    }

    const body = text.trim();
    if (!body || /^(?:[-*_]\s*){3,}$/.test(body) || /^[-*+]\s+\[[ xX]\]\s*$/.test(body)) continue;
    if (text.includes('|') && /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[index + 1] ?? '')) {
      table = true;
    }
    proseLines++;
    prose.push(body);
    const section = headings.at(-1);
    if (section) section.hasContent = true;
  }

  return { headings, prose: prose.join('\n'), proseLines, codeLines, codeBlocks, taggedBlocks, diagram, table };
}

type Markdown = ReturnType<typeof tokenizeMarkdown>;

function sectionCount(markdown: Markdown, patterns: RegExp[]): number {
  const matched = new Set<RegExp>();
  for (const heading of markdown.headings) {
    if (!heading.hasContent) continue;
    const pattern = patterns.find(candidate => candidate.test(heading.title));
    if (pattern) matched.add(pattern);
  }
  return matched.size;
}

function documentationScore(markdown: Markdown): number {
  const { headings, codeBlocks, taggedBlocks, codeLines, proseLines, diagram, table } = markdown;
  const depths = new Set(headings.filter(heading => heading.hasContent).map(heading => heading.depth));
  const hierarchy = depths.has(2) && (depths.has(1) || depths.has(3));
  const codeRatio = codeLines / Math.max(1, codeLines + proseLines);
  return sectionCount(markdown, documentationSections) * 10
    + (hierarchy ? 10 : 0)
    + Math.min(2, codeBlocks) * 8
    + Math.min(2, taggedBlocks) * 4
    + (codeRatio >= 0.05 && codeRatio <= 0.75 ? 6 : 0)
    + (diagram || table ? 10 : 0);
}

function pullRequestScore(markdown: Markdown, changedLines?: number): number {
  const words = markdown.prose.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  const sections = sectionCount(markdown, pullRequestSections);
  const issueReference = /(?:^|[\s(])(?:[\w.-]+\/[\w.-]+)?#\d+\b|https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/\d+\b/im.test(markdown.prose);
  const testingDetails = /(?:^|\n)\s*(?:\d+[.)]\s+|[-*]\s+\[[xX]\]\s+)|\b(?:npm test|pytest|go test|cargo test)\b/im.test(markdown.prose);
  const hasChangeSize = changedLines !== undefined && Number.isFinite(changedLines) && changedLines > 0;
  const depthTarget = hasChangeSize ? Math.min(180, Math.max(40, changedLines * 0.25)) : 60;
  return sections * 20
    + (issueReference ? 15 : 0)
    + (testingDetails || markdown.codeBlocks > 0 ? 10 : 0)
    + (sections > 0 ? Math.min(1, words / depthTarget) * 15 : 0);
}

function average(scores: number[]): number {
  return scores.length ? Math.round(scores.reduce((total, score) => total + score, 0) / scores.length) : 0;
}

export const CommunicationIntelligenceEngine = {
  /**
   * Scores observable communication in READMEs and PR descriptions.
   * PROHIBITED: personality scoring, emotional intelligence, leadership estimation.
   */
  analyzeArtifacts(artifacts: CommunicationArtifact[]): {
    documentationQuality: number;
    technicalExplanationClarity: number;
    communicationMaturity: number;
  } {
    const documentationScores: number[] = [];
    const pullRequestScores: number[] = [];

    for (const artifact of artifacts) {
      if (artifact.type === 'readme') {
        documentationScores.push(documentationScore(tokenizeMarkdown(artifact.content)));
      }
      if (artifact.type === 'pr') {
        pullRequestScores.push(pullRequestScore(tokenizeMarkdown(artifact.content), artifact.changedLines));
      }
    }

    const documentationQuality = average(documentationScores);
    const technicalExplanationClarity = average(pullRequestScores);
    return {
      documentationQuality,
      technicalExplanationClarity,
      communicationMaturity: Math.floor((documentationQuality + technicalExplanationClarity) / 2),
    };
  },
};
