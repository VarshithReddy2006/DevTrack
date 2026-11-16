/**
 * Small, dependency-free readers used by SystemDesignSignalExtractor.
 *
 * They only pull out the bits the extractor needs (service names, images, depends_on and
 * dependency names). They are line based on purpose: no eval, no object keys built from
 * file content, and they never throw on malformed input, they just return less.
 */

/** Repository file contents are only inspected up to this size. */
export const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_LINES = 20000;

export interface ComposeService {
  name: string;
  image: string | null;
  dependsOn: string[];
}

export interface ComposeTopology {
  services: ComposeService[];
}

/** Normalises a repo path: forward slashes, no leading "./" or "/". */
export function normalizePath(path: string): string {
  return String(path).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

export function baseName(path: string): string {
  const normalized = normalizePath(path);
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export function isDockerfileName(name: string): boolean {
  return /^dockerfile(\.[\w.-]+)?$/i.test(name) || /\.dockerfile$/i.test(name);
}

export function isComposeFileName(name: string): boolean {
  return /^(docker-)?compose(\.[\w.-]+)?\.ya?ml$/i.test(name);
}

function splitLines(content: string): string[] {
  if (typeof content !== 'string' || content.length > MAX_MANIFEST_BYTES) return [];
  return content.split(/\r?\n/, MAX_LINES);
}

/** Drops a trailing " # comment" that is not inside quotes. */
function stripComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const match = /^(["'])(.*)\1$/.exec(trimmed);
  return match ? match[2] : trimmed;
}

interface Row {
  indent: number;
  text: string;
}

function toRows(content: string): Row[] {
  const rows: Row[] = [];
  for (const raw of splitLines(content)) {
    const text = stripComment(raw).trimEnd();
    const trimmed = text.trim();
    if (!trimmed || trimmed === '---' || trimmed === '...') continue;
    rows.push({ indent: text.length - text.trimStart().length, text: trimmed });
  }
  return rows;
}

const KEY_RE = /^["']?([\w.-]+)["']?\s*:(?:\s+(.*))?$/;

/** Reads `[a, b]` or a block of `- a` / `a:` entries that follow a key. */
function readNameList(inline: string | undefined, rows: Row[], from: number, parentIndent: number): { names: string[]; next: number } {
  const names: string[] = [];
  const flow = /^\[(.*)\]$/.exec((inline ?? '').trim());
  if (flow) {
    flow[1].split(',').forEach(item => {
      const name = unquote(item);
      if (name) names.push(name);
    });
  }

  let i = from;
  let childIndent = -1;
  while (i < rows.length) {
    const row = rows[i];
    const isListAtParent = row.indent === parentIndent && row.text.startsWith('- ');
    if (row.indent <= parentIndent && !isListAtParent) break;
    if (childIndent === -1) childIndent = row.indent;
    if (row.indent === childIndent) {
      if (row.text.startsWith('- ')) {
        const name = unquote(row.text.slice(2));
        if (name) names.push(name);
      } else {
        const key = KEY_RE.exec(row.text);
        if (key) names.push(key[1]);
      }
    }
    i++;
  }
  return { names, next: i };
}

/**
 * Reads the `services:` block of a docker-compose file: service names, image and depends_on.
 * Supports the usual block style (list or map depends_on, inline `[a, b]`). Anchors, merge
 * keys and `extends` are ignored. Returns an empty topology for anything it cannot read.
 */
export function parseComposeTopology(content: string): ComposeTopology {
  const services: ComposeService[] = [];
  try {
    const rows = toRows(content);
    const start = rows.findIndex(row => row.indent === 0 && /^services\s*:\s*$/.test(row.text));
    if (start === -1) return { services };

    let i = start + 1;
    const serviceIndent = i < rows.length && rows[i].indent > 0 ? rows[i].indent : -1;
    if (serviceIndent === -1) return { services };

    while (i < rows.length && rows[i].indent > 0) {
      const head = rows[i];
      const headKey = head.indent === serviceIndent ? KEY_RE.exec(head.text) : null;
      if (!headKey) {
        i++;
        continue;
      }

      const service: ComposeService = { name: headKey[1], image: null, dependsOn: [] };
      i++;
      let fieldIndent = -1;
      while (i < rows.length && rows[i].indent > serviceIndent) {
        const row = rows[i];
        if (fieldIndent === -1) fieldIndent = row.indent;
        const field = row.indent === fieldIndent ? KEY_RE.exec(row.text) : null;
        i++;
        if (!field) continue;
        if (field[1] === 'image' && field[2]) {
          service.image = unquote(field[2]);
        } else if (field[1] === 'depends_on') {
          const parsed = readNameList(field[2], rows, i, fieldIndent);
          service.dependsOn = parsed.names;
          i = parsed.next;
        }
      }
      services.push(service);
    }
  } catch {
    return { services: [] };
  }
  return { services };
}

/** Lower-cased dependency names from a requirements.txt. */
export function parseRequirementsTxt(content: string): string[] {
  const names: string[] = [];
  for (const raw of splitLines(content)) {
    const line = stripComment(raw).trim();
    if (!line || line.startsWith('-')) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
    if (match) names.push(match[1].toLowerCase().replace(/_/g, '-'));
  }
  return names;
}

function quotedStrings(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) out.push(match[1] ?? match[2]);
  return out;
}

/** True when the text has a `]` outside quoted strings (so "pkg[extra]" does not close an array). */
function closesArray(text: string): boolean {
  return text.replace(/"[^"]*"|'[^']*'/g, '').includes(']');
}

function pythonRequirementName(spec: string): string | null {
  const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
  return match ? match[1].toLowerCase().replace(/_/g, '-') : null;
}

/** Dependency names from pyproject.toml (PEP 621 arrays and Poetry tables). */
export function parsePyproject(content: string): string[] {
  const names: string[] = [];
  let section = '';
  let inArray = false;
  for (const raw of splitLines(content)) {
    const line = stripComment(raw).trim();
    if (!line) continue;

    if (inArray) {
      quotedStrings(line).forEach(spec => {
        const name = pythonRequirementName(spec);
        if (name) names.push(name);
      });
      if (closesArray(line)) inArray = false;
      continue;
    }

    const header = /^\[+\s*([^\]]+?)\s*\]+$/.exec(line);
    if (header) {
      section = header[1];
      continue;
    }

    const pair = /^([\w.-]+|"[^"]+")\s*=\s*(.*)$/.exec(line);
    if (!pair) continue;
    const key = pair[1].replace(/"/g, '');
    const value = pair[2];

    const isPoetryTable = /^tool\.poetry\.(group\.[\w-]+\.)?(dev-)?dependencies$/.test(section);
    const isArrayTable = section === 'project.optional-dependencies' || section === 'dependency-groups';
    const isProjectDeps = section === 'project' && key === 'dependencies';

    if (isPoetryTable) {
      if (key !== 'python') names.push(key.toLowerCase().replace(/_/g, '-'));
    } else if (isProjectDeps || isArrayTable) {
      quotedStrings(value).forEach(spec => {
        const name = pythonRequirementName(spec);
        if (name) names.push(name);
      });
      if (value.trim().startsWith('[') && !closesArray(value)) inArray = true;
    }
  }
  return names;
}

/** Direct (non "// indirect") module paths from a go.mod, lower-cased. */
export function parseGoMod(content: string): string[] {
  const names: string[] = [];
  let inBlock = false;
  for (const raw of splitLines(content)) {
    const indirect = /\/\/\s*indirect/.test(raw);
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (inBlock) {
      if (line === ')') {
        inBlock = false;
        continue;
      }
      const dep = /^(\S+)\s+v\S+/.exec(line);
      if (dep && !indirect) names.push(dep[1].toLowerCase());
      continue;
    }
    if (/^require\s*\($/.test(line)) {
      inBlock = true;
      continue;
    }
    const single = /^require\s+(\S+)\s+v\S+/.exec(line);
    if (single && !indirect) names.push(single[1].toLowerCase());
  }
  return names;
}

/** Crate names from the dependency tables of a Cargo.toml. */
export function parseCargoToml(content: string): string[] {
  const names: string[] = [];
  let mode: 'none' | 'table' = 'none';
  for (const raw of splitLines(content)) {
    const line = stripComment(raw).trim();
    if (!line) continue;

    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header) {
      const section = header[1];
      const detailed = /^(?:workspace\.|target\.[^\]]+\.)?(?:dev-|build-)?dependencies\.([\w-]+)$/.exec(section);
      if (detailed) {
        names.push(detailed[1].toLowerCase());
        mode = 'none';
      } else {
        mode = /^(?:workspace\.|target\.[^\]]+\.)?(?:dev-|build-)?dependencies$/.test(section) ? 'table' : 'none';
      }
      continue;
    }

    if (mode === 'table') {
      const pair = /^([\w-]+)\s*=/.exec(line);
      if (pair) names.push(pair[1].toLowerCase());
    }
  }
  return names;
}

/** "groupId:artifactId" pairs from a Maven pom.xml, lower-cased. */
export function parsePomXml(content: string): string[] {
  const names: string[] = [];
  if (typeof content !== 'string' || content.length > MAX_MANIFEST_BYTES) return names;
  const block = /<dependency>([\s\S]*?)<\/dependency>/g;
  let match: RegExpExecArray | null;
  while ((match = block.exec(content)) !== null) {
    const group = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(match[1]);
    const artifact = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(match[1]);
    if (artifact) names.push(`${group ? group[1] : ''}:${artifact[1]}`.toLowerCase());
  }
  return names;
}

/** dependencies and devDependencies names from a package.json. */
export function parsePackageJson(content: string): { dependencies: string[]; devDependencies: string[] } {
  const empty = { dependencies: [], devDependencies: [] };
  if (typeof content !== 'string' || content.length > MAX_MANIFEST_BYTES) return empty;
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return empty;
    const pick = (value: unknown): string[] =>
      value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
    return { dependencies: pick(parsed.dependencies), devDependencies: pick(parsed.devDependencies) };
  } catch {
    return empty;
  }
}
