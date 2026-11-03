import { describe, expect, it } from 'vitest';
import { escapeRegExp } from '../shared/regex.js';

describe('escapeRegExp', () => {
  it('escapes every regex metacharacter', () => {
    const special = '.*+?^${}()|[]\\';
    const re = new RegExp(`^${escapeRegExp(special)}$`);
    expect(re.test(special)).toBe(true);
  });

  it.each(['c++', '(', '.*', 'a[b', 'x\\y', 'node.js', 'c#'])('matches %s literally', (value) => {
    const re = new RegExp(escapeRegExp(value), 'i');
    expect(re.test(`prefix ${value} suffix`)).toBe(true);
  });

  it('leaves plain text alone', () => {
    expect(escapeRegExp('binary search')).toBe('binary search');
  });
});
