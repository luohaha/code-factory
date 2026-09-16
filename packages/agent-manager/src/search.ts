const EMBEDDING_DIMENSIONS = 384;
export const SEARCH_EMBEDDING_VERSION = 1;

function normalizedText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/gu, ' ').trim();
}

function hashFeature(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function addFeature(vector: Float32Array, feature: string, weight: number): void {
  const hash = hashFeature(feature);
  const index = hash % vector.length;
  vector[index] = (vector[index] ?? 0) + ((hash & 0x80000000) === 0 ? weight : -weight);
}

/**
 * Produces a compact, deterministic local embedding from words and character n-grams.
 * It intentionally has no model download or network dependency, which keeps workspace
 * search private and makes indexing available immediately after Agent Manager starts.
 */
export function createSearchEmbedding(value: string): Buffer {
  const vector = new Float32Array(EMBEDDING_DIMENSIONS);
  const normalized = normalizedText(value);
  const words = normalized.match(/[\p{L}\p{N}_]+/gu) ?? [];

  for (const word of words) {
    const characters = Array.from(word);
    addFeature(vector, `word:${word}`, 2);
    for (const size of [2, 3, 4]) {
      if (characters.length < size) continue;
      for (let index = 0; index <= characters.length - size; index += 1) {
        addFeature(vector, `char${size}:${characters.slice(index, index + size).join('')}`, size === 3 ? 1.25 : 0.75);
      }
    }
  }

  let magnitudeSquared = 0;
  for (const component of vector) magnitudeSquared += component * component;
  const magnitude = Math.sqrt(magnitudeSquared);
  const buffer = Buffer.alloc(vector.length * Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < vector.length; index += 1) {
    buffer.writeFloatLE(magnitude === 0 ? 0 : (vector[index] ?? 0) / magnitude, index * Float32Array.BYTES_PER_ELEMENT);
  }
  return buffer;
}

export function searchEmbeddingSimilarity(left: Uint8Array, right: Uint8Array): number {
  if (left.byteLength !== right.byteLength || left.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) return 0;
  const leftBuffer = Buffer.from(left.buffer, left.byteOffset, left.byteLength);
  const rightBuffer = Buffer.from(right.buffer, right.byteOffset, right.byteLength);
  let similarity = 0;
  for (let offset = 0; offset < left.byteLength; offset += Float32Array.BYTES_PER_ELEMENT) {
    similarity += leftBuffer.readFloatLE(offset) * rightBuffer.readFloatLE(offset);
  }
  return Math.max(-1, Math.min(1, similarity));
}

export function fullTextQuery(value: string): string | null {
  const terms = normalizedText(value).match(/[\p{L}\p{N}_]+/gu) ?? [];
  const searchable = terms
    .filter((term) => Array.from(term).length >= 3)
    .map((term) => `"${term.replace(/"/gu, '""')}"`);
  return searchable.length > 0 ? searchable.join(' AND ') : null;
}

export function localFullTextScore(query: string, title: string, body: string, keywords: string): number {
  const normalizedQuery = normalizedText(query);
  if (!normalizedQuery) return 0;
  const normalizedTitle = normalizedText(title);
  const normalizedBody = normalizedText(body);
  const normalizedKeywords = normalizedText(keywords);
  if (normalizedTitle === normalizedQuery) return 1;
  if (normalizedTitle.includes(normalizedQuery)) return 0.95;
  if (normalizedKeywords.includes(normalizedQuery)) return 0.9;
  if (normalizedBody.includes(normalizedQuery)) return 0.85;

  const terms = normalizedQuery.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (terms.length === 0) return 0;
  const haystack = `${normalizedTitle}\n${normalizedBody}\n${normalizedKeywords}`;
  const matchedTerms = terms.filter((term) => haystack.includes(term)).length;
  return matchedTerms === terms.length ? 0.65 : matchedTerms / terms.length >= 0.5 ? 0.35 : 0;
}

export function searchExcerpt(value: string, query: string, maximumLength = 180): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  if (compact.length <= maximumLength) return compact;
  const matchIndex = normalizedText(compact).indexOf(normalizedText(query));
  const start = Math.max(0, (matchIndex < 0 ? 0 : matchIndex) - Math.floor(maximumLength / 3));
  const excerpt = compact.slice(start, start + maximumLength).trim();
  return `${start > 0 ? '…' : ''}${excerpt}${start + maximumLength < compact.length ? '…' : ''}`;
}
