const sensitive = /^(?:authorization|proxy.authorization|access.?token|refresh.?token|token|api.?key|password|passwd|secret|client.?secret|cookie|set.cookie|private.?key)$/i;
const hidden = '[REDACTED]';

export function redact(value: unknown, token: string): unknown {
  const clean = (text: string): string => {
    let result = token ? text.split(token).join(hidden) : text;
    result = result.replace(/\bBearer\s+[^\s"'<>]+/gi, `Bearer ${hidden}`);
    result = result.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, hidden);
    return result;
  };
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 64) return '[DEPTH_LIMIT]';
    if (typeof item === 'string') return clean(item);
    if (Array.isArray(item)) return item.map(child => visit(child, depth + 1));
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, child]) =>
        [clean(key), sensitive.test(key) ? hidden : visit(child, depth + 1)]));
    }
    return item;
  };
  return visit(value, 0);
}
