/**
 * tts-chunk.ts — Split text at sentence boundaries for TTS.
 *
 * Chatterbox has a ~2000 character hard limit per request. We split text at
 * sentence boundaries (period/exclamation/question mark followed by whitespace)
 * to avoid cutting mid-sentence, and fall back to mid-word splitting only when
 * a single sentence exceeds the max.
 */

/**
 * Split text into chunks no larger than maxChars, preferring sentence
 * boundaries. If a single sentence exceeds maxChars, splits at word
 * boundaries within that sentence.
 */
export function chunkText(text: string, maxChars: number): string[] {
  if (!text || text.trim().length === 0) return [];
  if (text.length <= maxChars) return [text.trim()];

  // Split on sentence boundaries: period, exclamation, question mark
  // followed by whitespace or end of string
  const sentencePattern = /[.!?]+\s+/g;
  const sentences: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = sentencePattern.exec(text)) !== null) {
    sentences.push(text.slice(lastIndex, match.index + match[0].length));
    lastIndex = sentencePattern.lastIndex;
  }
  // Get trailing text after last sentence boundary
  const remaining = text.slice(lastIndex);
  if (remaining.trim()) sentences.push(remaining);

  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    // If a single sentence exceeds maxChars, split it at word boundaries
    if (sentence.length > maxChars) {
      // Flush current chunk first
      if (current.trim()) {
        chunks.push(current.trim());
        current = "";
      }
      // Split long sentence into word-boundary chunks
      const words = sentence.split(/\s+/);
      let wordChunk = "";
      for (const word of words) {
        if (wordChunk && wordChunk.length + word.length + 1 > maxChars) {
          chunks.push(wordChunk.trim());
          wordChunk = word;
        } else {
          wordChunk = wordChunk ? wordChunk + " " + word : word;
        }
      }
      if (wordChunk.trim()) chunks.push(wordChunk.trim());
      continue;
    }

    if (current && current.length + sentence.length > maxChars) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }

  if (current.trim()) chunks.push(current.trim());

  return chunks.length > 0 ? chunks : [text.trim()];
}
