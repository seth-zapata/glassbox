/**
 * Corpus ingest: chunk, embed, upsert to Vectorize.
 *
 * Runs inside the Worker so it uses the same bindings the query path does — an ingest that
 * embedded with a different model or a different code path than retrieval would produce a
 * vector space the queries do not live in, and the failure would look like bad retrieval rather
 * than bad ingest.
 *
 * Documents are posted in by `scripts/ingest.ts` rather than bundled into the Worker: the corpus
 * is a repository artifact, and bundling it would ship 80 KB of markdown to every request for
 * the benefit of an operation that runs a handful of times.
 */

import { chunkDocument, type CorpusDoc } from "./chunk.ts";
import { EMBEDDER } from "./retrieve.ts";

/** Workers AI caps batch embedding; well under Vectorize's 1,000-vector upsert limit too. */
const EMBED_BATCH = 25;

export interface IngestReport {
  documents: number;
  chunks: number;
  upserted: number;
  embedMs: number;
  upsertMs: number;
  neurons: number;
  perDocument: Array<{ id: string; chunks: number }>;
}

export async function ingest(
  ai: Ai,
  index: VectorizeIndex,
  docs: CorpusDoc[],
): Promise<IngestReport> {
  const chunks = docs.flatMap((doc) => chunkDocument(doc));

  let embedMs = 0;
  let upsertMs = 0;
  let upserted = 0;
  let embeddedTokens = 0;

  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);

    const embedStarted = Date.now();
    const result = (await ai.run(EMBEDDER, { text: batch.map((c) => c.text) })) as {
      data: number[][];
    };
    embedMs += Date.now() - embedStarted;
    embeddedTokens += batch.reduce((sum, c) => sum + Math.ceil(c.text.length / 4), 0);

    const vectors: VectorizeVector[] = batch.map((chunk, j) => {
      const values = result.data[j];
      if (!values) throw new Error(`no embedding returned for chunk ${chunk.id}`);
      return {
        id: chunk.id,
        values,
        // Vectorize allows 10 KiB of metadata per vector; a ~1,600-char chunk fits with room to
        // spare, and storing the text here means retrieval needs no second lookup to show it.
        metadata: {
          docId: chunk.docId,
          docTitle: chunk.docTitle,
          sourceUrl: chunk.sourceUrl,
          index: chunk.index,
          text: chunk.text,
        },
      };
    });

    const upsertStarted = Date.now();
    // Upsert rather than insert: chunk ids are `${docId}#${index}`, stable across re-ingests, so
    // re-running replaces in place instead of accumulating duplicates.
    await index.upsert(vectors);
    upsertMs += Date.now() - upsertStarted;
    upserted += vectors.length;
  }

  const perDocument = docs.map((doc) => ({
    id: doc.id,
    chunks: chunks.filter((c) => c.docId === doc.id).length,
  }));

  return {
    documents: docs.length,
    chunks: chunks.length,
    upserted,
    embedMs,
    upsertMs,
    neurons: (embeddedTokens * 6_058) / 1_000_000,
    perDocument,
  };
}
