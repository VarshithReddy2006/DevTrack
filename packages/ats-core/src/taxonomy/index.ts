import taxonomy from './v1.json' with { type: 'json' };

export const SKILL_TAXONOMY_VERSION = taxonomy.version;

interface Skill {
  name: string;
  category: string;
}

const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const aliases = new Map<string, Skill>();

for (const { name, category, aliases: terms } of taxonomy.skills) {
  for (const term of [name, ...terms]) {
    const key = normalize(term);
    const existing = aliases.get(key);
    if (existing && existing.name !== name) throw new Error('Duplicate skill alias: ' + term);
    aliases.set(key, { name, category });
  }
}

const alternatives = [...aliases.keys()]
  .sort((left, right) => right.length - left.length)
  .map(term => term.replace(/[.*+?^{}$()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
const skillPattern = new RegExp(
  '(?<![\\p{L}\\p{N}_])(?:' + alternatives.join('|') + ')(?![\\p{L}\\p{N}_+#])',
  'giu',
);

export function canonicalSkillName(value: string): string | undefined {
  return aliases.get(normalize(value))?.name;
}

export function findSkillMentions(text: string): Array<Skill & { index: number }> {
  const mentions: Array<Skill & { index: number }> = [];
  for (const match of text.matchAll(skillPattern)) {
    const term = normalize(match[0]);
    const after = text.slice(match.index + match[0].length);
    // Bare Go and REST also appear as ordinary prose.
    if (term === 'go' && (match[0] !== 'Go' || /^\s+(?:to|beyond|ahead|through)\b/i.test(after))) continue;
    if (term === 'rest' && match[0] !== 'REST') continue;
    const skill = aliases.get(term);
    if (skill) mentions.push({ ...skill, index: match.index });
  }
  return mentions;
}
