const privateFields = /(?:authorization|cookie|password|secret|token$|credential|apikey|privatekey|prompt|resumetext|resumecontent|resumehtml|rawtext|parsedtext|extractedtext)|^(?:resume|text|content|body|headers|params|query|payload|stack)$/;

export function redactLogValue(key: string, value: unknown): unknown {
  const field = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (privateFields.test(field)) return '[REDACTED]';
  if (field === 'error') {
    const name = value instanceof Error ? value.name : value;
    return typeof name === 'string' && /^[a-z][a-z0-9_]{0,63}$/i.test(name) ? name : '[REDACTED]';
  }
  if (typeof value !== 'string') return value;
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[REDACTED]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\?[^\s"'#=]+=[^\s"'#]*/g, '?[REDACTED]');
}
