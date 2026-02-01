export function tokenize(query) {
  return String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
}
