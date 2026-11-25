import { MAX_MANIFEST_BYTES } from './manifestParsers.js';

export interface DockerfileSignals {
  hasMultiStageBuild: boolean;
  hasNonRootUser: boolean;
  hasHealthcheck: boolean;
  usesMinimalBaseImage: boolean;
}

const EMPTY_SIGNALS: DockerfileSignals = {
  hasMultiStageBuild: false,
  hasNonRootUser: false,
  hasHealthcheck: false,
  usesMinimalBaseImage: false,
};

function isNonRootUser(value: string): boolean {
  const user = value.split(':', 1)[0].trim();
  return Boolean(user) && !user.startsWith('$') && !/^(?:root|0)$/i.test(user);
}

function hasMinimalBase(image: string): boolean {
  return /distroless|(?:^|[-/:])(?:alpine|scratch)(?=[:@-]|$)/i.test(image);
}

/** Extracts deployment practices from Dockerfile instructions without executing them. */
export function parseDockerfile(content: unknown): DockerfileSignals {
  if (typeof content !== 'string' || content.length > MAX_MANIFEST_BYTES) return { ...EMPTY_SIGNALS };

  const stages: Array<{ baseImage: string; user: string | null; hasHealthcheck: boolean }> = [];
  let pending = '';

  const readInstruction = (line: string) => {
    const match = /^([A-Za-z]+)\s+(.*)$/.exec(line);
    if (!match) return;

    const instruction = match[1].toUpperCase();
    const argument = match[2].trim();
    if (instruction === 'FROM') {
      const image = argument.split(/\s+/).filter(token => !token.startsWith('--'))[0];
      if (image) stages.push({ baseImage: image, user: null, hasHealthcheck: false });
    } else if (instruction === 'USER' && stages.length > 0) {
      stages[stages.length - 1].user = argument.split(/\s+/)[0];
    } else if (instruction === 'HEALTHCHECK' && stages.length > 0) {
      stages[stages.length - 1].hasHealthcheck = !/^NONE\b/i.test(argument);
    }
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const line = `${pending} ${trimmed}`.trim();
    if (/\\\s*$/.test(line)) {
      pending = line.replace(/\\\s*$/, '');
      continue;
    }
    pending = '';
    readInstruction(line);
  }
  if (pending) readInstruction(pending);

  const finalStage = stages[stages.length - 1];
  return {
    hasMultiStageBuild: stages.length > 1,
    hasNonRootUser: Boolean(finalStage?.user && isNonRootUser(finalStage.user)),
    hasHealthcheck: Boolean(finalStage?.hasHealthcheck),
    usesMinimalBaseImage: Boolean(finalStage && hasMinimalBase(finalStage.baseImage)),
  };
}
