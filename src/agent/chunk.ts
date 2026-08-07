/**
 * Corpus chunking.
 *
 * Pure and dependency-free so it can be unit-tested without network or bindings — chunk
 * boundaries decide what retrieval can possibly find, so they are worth testing directly rather
 * than inferring from end-to-end results.
 */

export interface CorpusDoc {
  id: string;
  title: string;
  sourceUrl: string;
  body: string;
}

export interface Chunk {
  /** `${docId}#${index}` — stable across re-ingests so upserts replace rather than duplicate. */
  id: string;
  docId: string;
  docTitle: string;
  sourceUrl: string;
  index: number;
  text: string;
}

export interface ChunkOptions {
  /** Target size in characters. ~4 chars/token, so 1600 ≈ 400 tokens. */
  targetChars: number;
  /** Trailing characters repeated into the next chunk, so facts spanning a boundary survive. */
  overlapChars: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  targetChars: 1600,
  overlapChars: 240,
};

/**
 * Split on paragraph boundaries, accumulating until the target is reached.
 *
 * Paragraph-aligned rather than fixed-width because these documents are mostly prose and bullet
 * lists, where a mid-sentence cut can strip the qualifier that makes a fact correct — "wait 60
 * days before transferring" reads very differently without the clause naming what starts the
 * clock. A paragraph longer than the target is emitted whole rather than split, since splitting
 * it would do exactly that damage.
 */
export function chunkDocument(doc: CorpusDoc, options: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Chunk[] {
  const paragraphs = doc.body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: Chunk[] = [];
  let current: string[] = [];
  let currentLen = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    const text = current.join("\n\n").trim();
    if (text.length === 0) return;
    chunks.push({
      id: `${doc.id}#${chunks.length}`,
      docId: doc.id,
      docTitle: doc.title,
      sourceUrl: doc.sourceUrl,
      index: chunks.length,
      text,
    });
  };

  for (const paragraph of paragraphs) {
    if (currentLen > 0 && currentLen + paragraph.length > options.targetChars) {
      flush();
      // Carry the tail of the emitted chunk forward so a fact split across the seam is still
      // retrievable from the following chunk.
      const previous = chunks[chunks.length - 1]?.text ?? "";
      const carry = previous.slice(-options.overlapChars);
      current = carry ? [carry] : [];
      currentLen = carry.length;
    }
    current.push(paragraph);
    currentLen += paragraph.length;
  }
  flush();

  return chunks;
}

/** Front-matter parser for the committed corpus files. */
export function parseCorpusFile(raw: string, fallbackId: string): CorpusDoc {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match?.[1]) {
    return { id: fallbackId, title: fallbackId, sourceUrl: "", body: raw.trim() };
  }
  const front = match[1];
  const field = (name: string): string => {
    const m = front.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
    return m?.[1] ? m[1].replace(/^["']|["']$/g, "").trim() : "";
  };
  return {
    id: field("id") || fallbackId,
    title: field("title") || fallbackId,
    sourceUrl: field("source_url"),
    body: raw.slice(match[0].length).trim(),
  };
}
