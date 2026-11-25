import { MAX_MANIFEST_BYTES } from './manifestParsers.js';

export interface DockerfileSignals {
  hasMultiStageBuild: boolean;
  hasNonRootUser: boolean;
  hasHealthcheck: boolean;
  usesMinimalBaseImage: boolean;
}

export interface DockerfileStageInfo {
  index: number;
  alias: string | null;
  rawBaseImage: string;
  baseImage: string;
  inheritedFromStage: string | null;
  user: string | null;
  hasHealthcheck: boolean;
  usesMinimalBaseImage: boolean;
  copyFromRefs: string[];
}

export interface DockerfileParseDetails extends DockerfileSignals {
  stages: DockerfileStageInfo[];
  stageAliases: string[];
  referencedStageAliases: string[];
  resolvedArgs: Record<string, string>;
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
  return /(?:^|[/:_-])(?:alpine|distroless|scratch|slim)(?=[/:_@-]|$)/i.test(image);
}

/** Splits instruction arguments on whitespace while preserving quoted segments. */
function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < input.length) {
        current += input[++i];
      } else if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      hasToken = true;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }

    current += ch;
    hasToken = true;
  }

  if (hasToken) tokens.push(current);
  return tokens;
}

/**
 * Expands Dockerfile `$VAR`, `${VAR}`, `${VAR:-default}`, `${VAR-default}`,
 * `${VAR:+alt}`, and `${VAR+alt}` expressions against known build arguments/env.
 */
function interpolateVars(input: string, vars: Record<string, string>): string {
  const ESCAPED_DOLLAR = '\u0000ESCAPED_DOLLAR\u0000';
  let result = input.replace(/\\\$/g, ESCAPED_DOLLAR);

  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    const next = result.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:[-+]|[-+])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (_match, bracedName: string | undefined, op: string | undefined, operand: string | undefined, bareName: string | undefined) => {
        changed = true;
        const name = bracedName ?? bareName ?? '';
        const hasOwn = Object.prototype.hasOwnProperty.call(vars, name);
        const value = hasOwn ? vars[name] : undefined;

        if (!op) {
          return value ?? '';
        }
        const fallback = operand ?? '';
        if (op === ':-') return value ? value : fallback;
        if (op === '-') return value !== undefined ? value : fallback;
        if (op === ':+') return value ? fallback : '';
        if (op === '+') return value !== undefined ? fallback : '';
        return value ?? '';
      }
    );
    result = next;
    if (!changed) break;
  }

  return result.replaceAll(ESCAPED_DOLLAR, '$');
}

function parseArgInstruction(
  argument: string,
  target: Record<string, string>,
  globalArgs: Record<string, string>
): void {
  for (const token of tokenizeArgs(argument)) {
    const eqIndex = token.indexOf('=');
    if (eqIndex > 0) {
      const key = token.slice(0, eqIndex).trim();
      const rawVal = token.slice(eqIndex + 1);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        target[key] = interpolateVars(rawVal, target);
      }
    } else {
      const key = token.trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && Object.prototype.hasOwnProperty.call(globalArgs, key)) {
        target[key] = globalArgs[key];
      }
    }
  }
}

function parseEnvInstruction(argument: string, target: Record<string, string>): void {
  const tokens = tokenizeArgs(argument);
  if (tokens.length === 0) return;

  if (tokens[0].includes('=')) {
    for (const token of tokens) {
      const eqIndex = token.indexOf('=');
      if (eqIndex <= 0) continue;
      const key = token.slice(0, eqIndex).trim();
      const rawVal = token.slice(eqIndex + 1);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        target[key] = interpolateVars(rawVal, target);
      }
    }
    return;
  }

  const key = tokens[0].trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && tokens.length >= 2) {
    target[key] = interpolateVars(tokens.slice(1).join(' '), target);
  }
}

function extractEscapeDirective(content: string): string {
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith('#')) break;
    const match = /^#\s*escape\s*=\s*([`\\])\s*$/i.exec(trimmed);
    if (match) return match[1];
  }
  return '\\';
}

function collectLogicalLines(content: string, escapeChar: string): string[] {
  const lines: string[] = [];
  const trailingEscape = new RegExp(`${escapeChar === '\\' ? '\\\\' : escapeChar}\\s*$`);
  let pending = '';

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const line = `${pending} ${trimmed}`.trim();
    if (trailingEscape.test(line)) {
      pending = line.replace(trailingEscape, '');
      continue;
    }
    pending = '';
    lines.push(line);
  }

  if (pending) lines.push(pending);
  return lines;
}

/**
 * Parses a Dockerfile and returns stage-by-stage metadata including ARG interpolation,
 * multistage build aliases (`AS <stage>`), and `COPY --from=<stage>` references.
 */
export function parseDockerfileDetails(content: unknown): DockerfileParseDetails {
  if (typeof content !== 'string' || content.length > MAX_MANIFEST_BYTES) {
    return {
      ...EMPTY_SIGNALS,
      stages: [],
      stageAliases: [],
      referencedStageAliases: [],
      resolvedArgs: {},
    };
  }

  const escapeChar = extractEscapeDirective(content);
  const logicalLines = collectLogicalLines(content, escapeChar);

  const globalArgs: Record<string, string> = {};
  let stageVars: Record<string, string> = {};
  const stages: DockerfileStageInfo[] = [];
  const stageByAlias = new Map<string, DockerfileStageInfo>();
  const referencedAliases = new Set<string>();

  for (const line of logicalLines) {
    const match = /^([A-Za-z]+)\s+(.*)$/.exec(line);
    if (!match) continue;

    const instruction = match[1].toUpperCase();
    const argument = match[2].trim();

    if (instruction === 'ARG') {
      if (stages.length === 0) {
        parseArgInstruction(argument, globalArgs, globalArgs);
      } else {
        parseArgInstruction(argument, stageVars, globalArgs);
      }
      continue;
    }

    if (instruction === 'FROM') {
      const tokens = tokenizeArgs(argument);
      let cursor = 0;
      while (cursor < tokens.length && tokens[cursor].startsWith('--')) {
        cursor++;
      }

      const rawImageToken = tokens[cursor];
      if (!rawImageToken) continue;

      const expandedImage = interpolateVars(rawImageToken, globalArgs).trim() || rawImageToken;
      let alias: string | null = null;
      if (cursor + 2 < tokens.length && tokens[cursor + 1].toUpperCase() === 'AS') {
        const expandedAlias = interpolateVars(tokens[cursor + 2], globalArgs).trim();
        if (expandedAlias) alias = expandedAlias;
      }

      const parentStage = !/[/:@]/.test(expandedImage)
        ? stageByAlias.get(expandedImage.toLowerCase())
        : undefined;
      if (parentStage?.alias) {
        referencedAliases.add(parentStage.alias);
      }

      const resolvedBaseImage = parentStage ? parentStage.baseImage : expandedImage;
      const stage: DockerfileStageInfo = {
        index: stages.length,
        alias,
        rawBaseImage: rawImageToken,
        baseImage: resolvedBaseImage,
        inheritedFromStage: parentStage?.alias ?? null,
        user: parentStage ? parentStage.user : null,
        hasHealthcheck: parentStage ? parentStage.hasHealthcheck : false,
        usesMinimalBaseImage: hasMinimalBase(resolvedBaseImage),
        copyFromRefs: [],
      };

      stages.push(stage);
      if (alias) {
        stageByAlias.set(alias.toLowerCase(), stage);
      }
      // Build stage scope resets stage-local ARG/ENV; global ARGs require explicit `ARG <name>` to re-enter.
      stageVars = {};
      continue;
    }

    const currentStage = stages[stages.length - 1];
    if (!currentStage) continue;

    if (instruction === 'ENV') {
      parseEnvInstruction(argument, stageVars);
    } else if (instruction === 'USER') {
      const userToken = tokenizeArgs(argument)[0];
      if (userToken) {
        currentStage.user = interpolateVars(userToken, stageVars).trim();
      }
    } else if (instruction === 'HEALTHCHECK') {
      currentStage.hasHealthcheck = !/^NONE\b/i.test(argument);
    } else if (instruction === 'COPY') {
      for (const token of tokenizeArgs(argument)) {
        if (!token.startsWith('--from=')) continue;
        const ref = interpolateVars(token.slice('--from='.length), stageVars).trim();
        if (!ref) continue;
        currentStage.copyFromRefs.push(ref);
        const byAlias = stageByAlias.get(ref.toLowerCase());
        if (byAlias && byAlias.index < currentStage.index && byAlias.alias) {
          referencedAliases.add(byAlias.alias);
        } else if (/^\d+$/.test(ref)) {
          const idx = Number(ref);
          const byIndex = idx < currentStage.index ? stages[idx] : undefined;
          if (byIndex?.alias) referencedAliases.add(byIndex.alias);
        }
      }
    }
  }

  const finalStage = stages[stages.length - 1];
  const stageAliases = stages
    .map(stage => stage.alias)
    .filter((alias): alias is string => Boolean(alias));

  return {
    hasMultiStageBuild: stages.length > 1,
    hasNonRootUser: Boolean(finalStage?.user && isNonRootUser(finalStage.user)),
    hasHealthcheck: Boolean(finalStage?.hasHealthcheck),
    usesMinimalBaseImage: Boolean(finalStage?.usesMinimalBaseImage),
    stages,
    stageAliases,
    referencedStageAliases: Array.from(referencedAliases),
    resolvedArgs: { ...globalArgs, ...stageVars },
  };
}

/** Extracts deployment practices from Dockerfile instructions without executing them. */
export function parseDockerfile(content: unknown): DockerfileSignals {
  const { hasMultiStageBuild, hasNonRootUser, hasHealthcheck, usesMinimalBaseImage } = parseDockerfileDetails(content);
  return {
    hasMultiStageBuild,
    hasNonRootUser,
    hasHealthcheck,
    usesMinimalBaseImage,
  };
}
