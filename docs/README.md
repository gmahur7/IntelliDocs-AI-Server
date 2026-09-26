# RAG Accuracy Investigation & Solution

> Scope: IntelliDocs backend (`server/`), branch `ConverSationMemory`, commit `1810a3b`.
> Status: **investigation + plan only. No source code has been changed.**
> All file links below are relative to this `docs/` folder.

---

## 1. Executive Summary

Simple questions fail because of **a few specific defects in this codebase**, not because the
system is missing advanced RAG techniques. In order of impact:

1. **The embedding model is used without its required task prefixes.** `nomic-embed-text` is trained
   to embed `search_query: …` and `search_document: …` inputs. This project sends raw text for
   both (see [ollama.client.ts:94-106](../src/client/ollama.client.ts#L94-L106)). The short user question
   and the 900-char passages end up in poorly aligned regions of the vector space, so the chunk
   that contains the answer often doesn't make the top 5.
2. **The answer model is `llama3.2:1b`.** A 1B-parameter model has to read about 1,200 tokens of noisy context
   and follow a strict "reply exactly …" refusal rule. It regularly gives the refusal even when the
   answer is in the context, and it hallucinates when it doesn't refuse. `docker-compose.yml`
   **hard-codes** this model in three places, so changing `.env` has no effect in Docker.
3. **The prompt works against a small model.** The question comes before the context. Each chunk is
   prefixed with two UUIDs (about 40 tokens of noise per chunk). Sampling runs at Ollama's default
   temperature (0.8). Earlier refusals and hallucinations are replayed as chat history, so the model
   learns to repeat them.
4. **Chunking cuts through words, sentences, and headings.** The chunker is a fixed 900-character
   window ([chunking.service.ts:83-99](../src/services/chunking.service.ts#L83-L99)). I verified that it
   splits mid-word (`"…veniam, qui"` / `"rem ipsum…"`).
5. **Retrieval uses vectors only, with a small top-K.** The query has no lexical signal, so
   questions about exact names, numbers, clause IDs, or codes depend entirely on a generic 768-dimension
   embedding.

Other problems reduce quality: table cells are merged into one line, the conversation memory
contaminates answers, nothing logs retrieval or prompts, and the vector index is fragile.

**Recommended fix, in order:** (1) add embedding prefixes and reindex, (2) use a stronger chat
model with low temperature and a rewritten prompt, (3) switch to sentence- and heading-aware
chunking, (4) add hybrid vector + Postgres full-text retrieval with a larger candidate pool,
(5) clean up context construction, (6) harden the conversation memory, and (7) add debug tracing
and a small evaluation script. Each step is small and local. The only optional schema change is an
additive `originalName` column. Reranking is **deferred** until the evaluation shows it is needed
(see §11).

---

## 2. Current RAG Architecture

```text
POST /api/v1/files/upload
  └─ file.controller → B2 upload (key = <uuid>.<ext>; original filename DISCARDED)
     └─ Document row (PENDING) → RabbitMQ doc.ingest.parse

ingest.worker (separate process)
  1. download from B2
  2. FileParserService.parseByMime       pdf-parse v2 getText() → per-page text (tab = cell gap)
  3. normalizeText (per page)            collapses [ \t]+ → " "  (table columns lost)
  4. detectScannedPages                  <12 letters/digits → page skipped (no OCR)
  5. ChunkingService.chunkPages          fixed 900-char window, 150 overlap, char offsets
  6. EmbeddingService.embedMany          nomic-embed-text, NO task prefix, one request per document
  7. delete old chunks → INSERT … ::vector (768) → markReady

POST /api/v1/ask  |  /ask/stream
  RagService.prepare
  1. load conversation + last ≤10 msgs / ≤1200 tokens of history
  2. CondenseService.condense            (only if history) rewrite with llama3.2:1b
  3. RetrievalService.retrieveTopK       embed query (NO prefix) → top-5 by cosine distance
     SQL: WHERE userId, status='READY', optional documentId  ORDER BY embedding <=> q  LIMIT k
  4. contextBlocks = "[chunk_i] (<docUUID>/<chunkUUID> p.N) text"
  5. messages = [system, ...history, user(prompt: rules + Question + Context)]
  6. OllamaService.chat / chatStream     llama3.2:1b, num_ctx 4096, default temperature
  7. saveTurn (question, answer, citations)
```

There is no query expansion, HyDE, multi-query, hybrid search, reranking, relevance threshold, or
retrieval logging.

---

## 3. Current Implementation Analysis

### 3.1 Document ingestion — [file-parser.service.ts](../src/services/file-parser.service.ts)

| Aspect           | Finding                                                                                                                                                                                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parser           | `pdf-parse` v2 `getText()` with **default** options: `lineEnforce: true`, `cellSeparator: "\t"`. Per-page text is correct, and page numbers are reliable.                                                                                                                                          |
| Pages skipped    | Only pages with fewer than `RAG_MIN_PAGE_TEXT_CHARS` (12) letters/digits. These are recorded in `Document.warning`. This is a reasonable design.                                                                                                                                                   |
| OCR              | None. Image-only pages can't be answered. The system reports this, but it's a real source of "not found" answers for scanned PDFs.                                                                                                                                                                 |
| Tables           | pdf-parse separates cells with `\t`. **`normalizeText` then collapses `\t` into a space** ([text-normalizer.ts:20](../src/utils/text-normalizer.ts#L20)). Verified: `"Plan\tPrice\tRefund window\nPro\t$25\t30 days"` → `"Plan Price Refund window\nPro $25 30 days"`. Column boundaries are gone. |
| Headings / lists | Line breaks are kept (`lineEnforce`), but headings and bullets have no structure after that. The chunker doesn't use them.                                                                                                                                                                         |
| Metadata         | Only `pageStart`/`pageEnd`. The **original filename is discarded**: the B2 key is `randomUUID()+ext` ([b2.service.ts:99](../src/services/b2.service.ts#L99)) and `Document` has no name column. The LLM can't tell documents apart except by UUID.                                                 |
| TXT              | A whole TXT file becomes page 1, so every citation is "p.1". This is acceptable.                                                                                                                                                                                                                   |

### 3.2 Preprocessing — [text-normalizer.ts](../src/utils/text-normalizer.ts)

- NFC normalization, control characters → space, CRLF → LF, collapsed spaces, capped blank lines. **Safe overall.**
- Losses: tab-delimited table cells are collapsed (above). Hyphenation at line ends is not repaired
  (`reim-\nbursement` stays split, which hurts both FTS and embeddings). Hard line breaks inside
  paragraphs are kept. Repeated headers and footers ("Company Confidential — Page 3") are not removed,
  so they appear in every chunk and dilute its embedding.
- There is no truncation or encoding bug. UTF-8 decoding for TXT is correct.

### 3.3 Chunking — [chunking.service.ts](../src/services/chunking.service.ts)

- Character-based sliding window: `size=900`, `overlap=150` (about 225 / 40 tokens). The window
  ignores word, sentence, paragraph, and heading boundaries ([L83-99](../src/services/chunking.service.ts#L83-L99)).
- I ran the real `chunkPages` on sample text:
  ```text
  chunk 0 END:   "…Ut enim ad minim veniam, qui"
  chunk 1 START: "rem ipsum dolor sit amet, …"
  ```
  Words are cut in half, which means numbers and names can be too (`"30 da" | "ys"`). A heading
  that falls near the end of a window is separated from the body it introduces.
- Page mapping (joining pages, then mapping offsets back to page ranges) is **well designed and
  should be kept**. Only the boundary selection needs to change.

### 3.4 Embeddings — [embedding.service.ts](../src/services/embedding.service.ts), [ollama.client.ts](../src/client/ollama.client.ts)

- The model is `nomic-embed-text` (768 dimensions), and the same model is used for indexing and querying. The dimension matches `vector(768)`.
- **No task prefixes.** Nomic's model card requires `search_document: ` on indexed text and
  `search_query: ` on queries. Without them, a question like _"How many days do I have to request a refund?"_
  is embedded as a short, generic sentence and scores against passages much less reliably.
- Normalization: Ollama `/api/embed` returns L2-normalized vectors, and retrieval uses cosine (`<=>`).
  These are consistent, so there's no bug here.
- Staleness: nothing records which model or prefix scheme produced a chunk's vector. Once the prefix
  fix ships, **every existing document must be reindexed**, or old and new vectors will be mixed.
- Throughput: `embedMany` sends the **whole document in one request** with a 60 s axios timeout
  ([worker L67](../src/workers/ingest.worker.ts#L67), [client L24](../src/client/ollama.client.ts#L24)).
  With the remote ngrok Ollama in `.env`, a large PDF can time out, retry, and eventually end up in
  the DLQ. The document then never reaches `READY`, and questions about it fail with "No indexed content".

### 3.5 Vector database — [document-chunk.repository.ts](../src/repositories/document-chunk.repository.ts), `prisma/migrations/`

- The database is Postgres + pgvector. The query computes cosine distance (`<=>`), and `score` is a
  **distance** (lower is better).
- Filters: `d."userId" = $2 AND d.status = 'READY' AND ($3 IS NULL OR d.id = $3)`. These are correct
  and don't wrongly exclude relevant chunks.
- There is no similarity threshold, so the top K are always returned. Deduplication is handled by
  `ON CONFLICT (documentId, seq)` plus delete-before-insert, so there are no duplicates.
- **Index state:** migration `20260924083636_y` **drops** the hand-written ivfflat index
  ([migration.sql:5](../prisma/migrations/20260924083636_y/migration.sql#L5)). Prisma didn't know
  about the index, so `prisma migrate dev` generated a `DROP`. Today the query is an exact sequential scan. That's
  actually the _best_ case for recall, but it's accidental:
  - Any future `prisma migrate dev` will drop any hand-written index again.
  - If the ivfflat index is restored as written (`lists = 100`, built on a near-empty table, default
    `ivfflat.probes = 1`), pgvector searches **only 1 of 100 lists** and _then_ applies the
    `userId`/`documentId` filter. This can return fewer than K rows, or zero, even when the answer
    exists. **Do not restore it as written.**
- I couldn't inspect the live database (the Docker daemon wasn't running during the investigation). Use the queries in §21
  to confirm the index state.

### 3.6 Retrieval — [retrieval.service.ts](../src/services/retrieval.service.ts)

- Pure dense search with `topK = RAG_DEFAULT_TOP_K = 5` (maximum 12). There's no lexical search,
  no candidate pool larger than what the LLM sees, no reranking, and no merging of neighbouring chunks.
- For a user with several documents, five slots are shared across all of them.

### 3.7 Query transformation — [condense.service.ts](../src/services/condense.service.ts)

- The query is only transformed when the conversation has history. The first turn uses the raw
  question, which is correct.
- On follow-up turns, `llama3.2:1b` rewrites the question at temperature 0.8. The rewritten query
  **replaces** the original for retrieval. A 1B model often adds or drops key terms, so retrieval
  can go wrong even when the user's own question would have worked. The only guard is
  `length > question.length + 300`.

### 3.8 Context construction — [rag.service.ts:136-141](../src/services/rag.service.ts#L136-L141)

```ts
`[chunk_${index + 1}] (${chunk.documentId}/${chunk.id}${formatPageLabel(...)}) ${chunk.text}`
```

- Two 36-character UUIDs per chunk add noise that small models copy into their answers.
- Chunks are ordered by distance, not by position in the document, so neighbouring chunks
  of the same passage can appear out of order. The 150-character overlaps are duplicated.
- There's no document name and no token budget. Ollama silently truncates the **start** of the prompt
  when `num_ctx` (4096) is exceeded. With history (≤1200 tokens) plus top-12 chunks, that limit
  is reachable.

### 3.9 Prompt — [rag.service.ts:33-46, 144-155](../src/services/rag.service.ts#L33-L46)

- The rules come first, then `Question:`, then `Context:`. The question sits _before_ about 1,200
  tokens of context, so a 1B model has "forgotten" it by the time it finishes reading.
- `"Answer using ONLY the context"`, the system message "do not hallucinate", and an exact refusal
  string are all strong refusal cues. For a small model, refusing becomes the safest completion.
- Nothing tells the model that the question may use different words than the document, which is
  the paraphrase case (_refund period_ vs _request a refund_).
- `temperature` isn't set, so it defaults to 0.8. Answers to the same question vary from run to run.

### 3.10 Conversation memory — [conversation.service.ts:47-75](../src/services/conversation.service.ts#L47-L75)

- Up to 10 messages or 1200 tokens are replayed **verbatim as chat turns** before the grounded
  prompt, including earlier assistant answers. Earlier refusals ("I could not find this…")
  and hallucinations are replayed as if they were correct. A small model tends to copy the pattern
  of its previous answers, so one bad answer can repeat for the rest of the conversation.
- The conversation's pinned `documentId` is used when the request doesn't send one. That's correct.

---

## 4. Identified Problems

### Critical Problems

These directly explain why simple questions fail.

| #   | Problem                                                                                                                                                                             | Where                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | `nomic-embed-text` is used without the `search_query:` / `search_document:` prefixes. Queries and passages are misaligned, and the gold chunk drops out of the top 5.               | [ollama.client.ts:94](../src/client/ollama.client.ts#L94), [ingest.worker.ts:67](../src/workers/ingest.worker.ts#L67), [retrieval.service.ts:23](../src/services/retrieval.service.ts#L23) |
| C2  | The generator is `llama3.2:1b`, which is too weak for grounded reading comprehension over 5+ passages. This causes false refusals and hallucinations. Compose hard-codes the model. | [env.ts:47](../src/config/env.ts#L47), [docker-compose.yml:56,103,129](../docker-compose.yml#L103), `.env`                                                                                 |
| C3  | The prompt is built against a small model: question before context, UUID noise, strong refusal priming, no guidance about paraphrases, temperature 0.8.                             | [rag.service.ts:33-46,136-155](../src/services/rag.service.ts#L33-L46), [ollama.client.ts:36](../src/client/ollama.client.ts#L36)                                                          |

### Major Problems

These significantly reduce quality.

| #   | Problem                                                                                                                                                   | Where                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | The fixed character window cuts words, sentences, numbers, and heading→body links.                                                                        | [chunking.service.ts:83-99](../src/services/chunking.service.ts#L83-L99)                                                                                       |
| M2  | Retrieval is vector-only with top-5. It has no lexical match for names, numbers, or IDs, and no candidate pool larger than what the LLM sees.             | [retrieval.service.ts](../src/services/retrieval.service.ts), [document-chunk.repository.ts:82-106](../src/repositories/document-chunk.repository.ts#L82-L106) |
| M3  | History contamination: earlier answers (including refusals) are replayed verbatim, and the condensed query _replaces_ the original for retrieval.         | [rag.service.ts:122,150](../src/services/rag.service.ts#L122), [condense.service.ts](../src/services/condense.service.ts)                                      |
| M4  | Table structure is destroyed by the normalizer (`\t` → space).                                                                                            | [text-normalizer.ts:20](../src/utils/text-normalizer.ts#L20)                                                                                                   |
| M5  | There's no retrieval or prompt tracing, so a failure can't be traced to a specific stage.                                                                 | whole `/ask` path                                                                                                                                              |
| M6  | The vector index is fragile: Prisma drops it on migrate, and restoring the old ivfflat index as written would **silently reduce recall** under filtering. | [migrations/20260924083636_y](../prisma/migrations/20260924083636_y/migration.sql#L5)                                                                          |

### Minor Problems

| #   | Problem                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------- |
| m1  | The original filename isn't stored, so the model can't name or distinguish documents.                     |
| m2  | There's no token budget for context. Ollama truncates silently once `num_ctx` is exceeded.                |
| m3  | Duplicate overlap text and distance-ordered (not reading-ordered) chunks in the context.                  |
| m4  | Hyphenation at line breaks isn't repaired, and repeated headers and footers aren't removed.               |
| m5  | Embedding runs as a single request per document with a 60 s timeout, so large docs can go to the DLQ.     |
| m6  | Nothing records the embedding version, so stale vectors can't be detected after a model or prefix change. |
| m7  | There's no OCR. Scanned pages are skipped, which is documented through `Document.warning`.                |

---

## 5. Root Cause Analysis

Take the failing example _"How many days do I have to request a refund?"_ against a document
containing _"The refund period is 30 days from the date of purchase."_ Stage by stage:

| Stage     | What happens today                                                                                                                                                        | Failure mode caused                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Ingestion | The sentence is extracted correctly from a text PDF. If it's inside a table, its columns merge into one line.                                                             | Mostly OK (tables are the exception) |
| Chunking  | The sentence may be split across two windows ("…refund period is 30 da" / "ys from the date…"), and a heading such as "4. Refund Policy" may end up in a different chunk. | **Incomplete chunks**                |
| Embedding | The passage and query are embedded without task prefixes, so a short question ranks badly against long passages.                                                          | **Irrelevant / no useful chunks**    |
| Retrieval | Only 5 candidates are returned, with no lexical signal for "refund". If the gold chunk ranks 6th, it's gone.                                                              | **No useful chunks**                 |
| Context   | Chunks arrive as `[chunk_3] (c1f0…/9ab2… p.4) …`, out of order and with duplicated overlaps.                                                                              | Noise                                |
| Prompt    | The question comes before the context, with a strong refusal instruction.                                                                                                 | **"Not available" when it is**       |
| LLM       | A 1B model at temperature 0.8.                                                                                                                                            | **Refusal or hallucination**         |
| Memory    | A refusal from an earlier turn is replayed as history.                                                                                                                    | **Repeated wrong answers**           |

So two independent paths each cause the failures:

- **Retrieval path (C1 + M1 + M2):** the right chunk isn't in the context.
- **Generation path (C2 + C3 + M3):** the right chunk _is_ in the context, but the model refuses or makes things up.

Both need fixing. The debug trace in §17.7 tells you which path failed for a given question.

---

## 6. Document Processing Improvements

1. **Keep table cells separated.** Before whitespace collapsing, map tabs to `|`.
   pdf-parse's default `cellSeparator` is already `\t`, so the parser doesn't need to change.
2. **Repair line-break hyphenation:** `(\p{L})-\n(\p{L})` → `$1$2`.
3. **Remove repeated headers and footers** (optional, cheap): a short line that appears on at least 60% of
   pages (after replacing digits with `#`) is boilerplate. Drop it before chunking.
4. **Store the original filename** (optional, additive nullable column `Document.originalName`) so the
   prompt can say _"Source: refund-policy.pdf, p.4"_ and the model can distinguish documents.
5. OCR remains out of scope. The existing `warning` already tells the user which pages were skipped.

---

## 7. Chunking Improvements

**Replace the boundary selection, and keep the page mapping.** The new chunker:

- splits the joined text into _atoms_ (sentences, or lines when a line has no terminal punctuation)
  and records their character offsets;
- packs whole atoms greedily up to `RAG_CHUNK_SIZE` characters, and hard-splits an atom at a space
  only when that atom alone is longer than the chunk size;
- never ends a chunk on a heading-like line, so the heading moves forward and stays with its body;
- builds overlap from whole trailing sentences (up to `RAG_CHUNK_OVERLAP` characters), never partial words;
- reuses the existing `ranges` → `pageStart`/`pageEnd` mapping unchanged.

Recommended sizes: `RAG_CHUNK_SIZE=1000`, `RAG_CHUNK_OVERLAP=200` (about 250 / 50 tokens). These are small
enough for precise embeddings and large enough to keep a policy clause together. I tested this
implementation on sample text (see §17.3): it produced no mid-word cuts or empty chunks, and it
kept "4. Refund Policy" in the same chunk as its content.

Semantic or embedding-based chunking and parent-child retrieval are **not** recommended at this
stage. They add ingestion cost and complexity, and neighbour expansion (§12) captures most of the benefit.

---

## 8. Embedding Improvements

1. **Add task prefixes** (C1). Make them configurable, because they're model-specific:
   `RAG_EMBED_QUERY_PREFIX="search_query: "`, `RAG_EMBED_DOCUMENT_PREFIX="search_document: "`.
   Store the **raw** text in `DocumentChunk.text` and apply the prefix only when embedding.
2. **Batch document embedding** in groups of 32 (m5).
3. **Reindex all documents** after deploying. Use the existing `POST /documents/:id/reindex`, or run the
   SQL-plus-enqueue script in §16 Step 8.
4. Keep `nomic-embed-text` for now. It's a reasonable English retrieval model _once it's used correctly_.
   Only consider `mxbai-embed-large` (1024-d) or `bge-m3` if the evaluation still shows poor Recall@20
   after the fixes. Those models require the column-type migration described in CLAUDE.md.

---

## 9. Vector Database Improvements

1. **Keep exact search for now.** An exact cosine scan over one user's chunks is fast up to roughly 100k rows, and it
   has perfect recall. The current accidental state is fine.
2. When an index is needed, **use HNSW, not ivfflat**. Enable iterative scans so that filters
   can't starve the result set (pgvector ≥ 0.8):
   ```sql
   CREATE INDEX IF NOT EXISTS "DocumentChunk_embedding_hnsw_cos_idx"
     ON "DocumentChunk" USING hnsw ("embedding" vector_cosine_ops);
   -- per query / per session:
   SET hnsw.ef_search = 100;
   SET hnsw.iterative_scan = relaxed_order;
   ```
3. **Guard against Prisma dropping it.** Whenever `prisma migrate dev` generates a migration, check it
   for `DROP INDEX "DocumentChunk_embedding_…"` and delete that line before applying. That's exactly how
   `20260924083636_y` lost the index. Add a note in CLAUDE.md.
4. Return `c.seq` from the query (needed for neighbour expansion and ordering).

---

## 10. Retrieval Improvements

**Hybrid retrieval: dense cosine plus Postgres full-text, fused with Reciprocal Rank Fusion (RRF).**

Why it applies here: the target documents are policies, contracts, and manuals, which are full of exact
tokens (numbers, dates, names, clause IDs, product codes). A generic 768-d embedding represents these
weakly, while Postgres FTS matches them exactly. Postgres is already in the stack, so this needs **no new infrastructure**.

- Retrieve 20 candidates from each retriever, fuse with RRF (`k=60`), and keep the top `RAG_CONTEXT_CHUNKS` (6).
- Build the full-text query as an **OR** of the question's lexemes:
  `replace(plainto_tsquery('english', $q)::text, '&', '|')::tsquery`.
  `plainto_tsquery` alone ANDs every word, which almost never matches a natural-language question.
- Compute `to_tsvector` on the fly for now (no schema change, fine at this scale). Add a GIN expression
  index later if needed, with the same Prisma-drop caveat as §9.
- **Query for retrieval:** on follow-up turns, run retrieval for _both_ the original question and the
  condensed question, and fuse the results. This way a bad rewrite can't remove the right chunk.
- **Do not add** HyDE, multi-query, query decomposition, or agentic RAG. Each one adds an extra
  LLM call that, with a small local model, is more likely to distort the query than improve it.
  Simple factual questions need the original wording.

---

## 11. Reranking Improvements

**Not recommended yet, and here's the reasoning.** Ollama has no rerank endpoint. Adding one would
mean a new service (e.g. Hugging Face TEI with `bge-reranker-base`) or in-process ONNX
(`@huggingface/transformers`), which is a new dependency and latency on every request.
Decide based on the evaluation in §18:

- If **Recall@20 is high but Recall@6 is low** after Steps 1–5, the right chunk is being retrieved but ranked
  poorly. A cross-encoder reranker (20 → 6) is then justified, and it plugs in after `hybridSearch`
  in `RetrievalService`.
- If Recall@20 is itself low, reranking can't help. The problem is ingestion, chunking, or embeddings.

---

## 12. Context Construction Improvements

1. **Neighbour expansion:** for each selected chunk, optionally include the chunks at `seq ± 1` of the
   same document, capped by the token budget. This recovers answers that straddle a chunk boundary,
   and it's cheap (one indexed query on `(documentId, seq)`).
2. **Merge and order:** group by document, sort by `seq`, and merge consecutive chunks so each passage reads
   continuously. Trim the duplicated overlap when merging.
3. **Clean labels:** `[Source 2 | refund-policy.pdf | p.4-5]`, with no UUIDs. Keep the UUID mapping
   only in `citations`. If `originalName` isn't added, use `Document 1`, `Document 2`, and so on.
4. **Token budget:** `contextBudget = OLLAMA_NUM_CTX − historyTokens − promptOverhead − answerReserve(512)`.
   Drop the lowest-ranked sources until the context fits, and never exceed `num_ctx` silently.

---

## 13. Prompt Improvements

A more capable model plus a clearer prompt fixes C2 and C3. The question comes **after** the sources,
there's explicit guidance about paraphrases, and exact-value rules. The refusal is still an exact
sentence (the frontend may depend on it), but it's positioned as a last resort:

```text
SYSTEM
You are IntelliDocs, an assistant that answers questions using the user's uploaded documents.

Rules:
1. Base every statement on the SOURCES in the user message. Do not use outside knowledge.
2. The question may use different words than the document (e.g. "how long do I have to get my
   money back" vs "refund period is 30 days"). Read every source carefully before deciding.
3. Copy numbers, dates, amounts, names and defined terms exactly as they appear.
4. Cite the page after each fact, like (p.4). If sources come from more than one document,
   name the document too, like (refund-policy.pdf, p.4).
5. If the sources contain part of the answer, give that part and say what is missing.
6. Only if the sources contain nothing relevant, reply exactly:
   I could not find this in your uploaded documents.
7. Earlier conversation turns are only for understanding what the user refers to.
   They are not a source of facts.
Answer directly and concisely.

USER
SOURCES:
[Source 1 | refund-policy.pdf | p.4]
4. Refund Policy
The refund period is 30 days from the date of purchase. …

[Source 2 | refund-policy.pdf | p.5]
…

QUESTION: How many days do I have to request a refund?
```

Ollama options: `temperature: 0.1`, `top_p: 0.9`, `num_ctx: 8192` (llama3.2 / qwen2.5 support it;
make sure the host has the memory).

**Model:** use at least `llama3.2:3b`, and preferably `qwen2.5:7b-instruct` or `llama3.1:8b` if the Ollama host
can run them. Keep `CondenseService` on the same model, because query rewriting is also unreliable at 1B.

---

## 14. Conversation/Memory Improvements

1. **Retrieve with both queries** (original and condensed), fused with RRF (§10).
2. **Don't replay refusals:** drop any assistant turn equal to the refusal sentence, _and the user turn
   before it_, from the history passed to the answer model and the condenser.
3. **Shorter answer history:** the answer model gets at most the last 4 messages (2 turns). The condenser
   can keep the current budget.
4. **Condense deterministically:** `temperature: 0`, and skip condensing when the question has no
   pronoun or ellipsis signals (`it|that|this|they|those|these|he|she|its|their|them|the same|and |what about`).
   A standalone question is then used exactly as the user wrote it.
5. Tell the model in the system prompt that history is for resolving references only (rule 7 above).

---

## 15. Recommended Architecture

```text
CURRENT                                         IMPROVED
───────                                         ────────
pdf-parse getText                               pdf-parse getText (unchanged)
normalize: \t→space                             normalize: \t→" | ", de-hyphenate, strip repeated header/footer
fixed 900-char window                           sentence/heading-aware packer (1000/200), same page mapping
embed raw text, 1 request                       embed "search_document: "+text, batches of 32
pgvector exact scan (index dropped)             pgvector exact scan (HNSW + iterative scan when needed)
query: condensed only (1B, temp 0.8)            query: original + condensed (temp 0, only when needed)
embed raw query                                 embed "search_query: "+q
top-5 dense                                     dense top-20 ∪ FTS top-20 → RRF → top-6
—                                               (reranker only if eval shows Recall@20 ≫ Recall@6)
[chunk_i] (uuid/uuid p.N) text, distance order  [Source i | name | p.N], neighbour-expanded, merged, reading order, token-budgeted
rules → question → context, refusal-primed      system rules; SOURCES → QUESTION; paraphrase + exact-value guidance
llama3.2:1b, temp 0.8, num_ctx 4096             llama3.2:3b+ (qwen2.5:7b ideal), temp 0.1, num_ctx 8192
history: 10 msgs verbatim incl. refusals        history: last 4 msgs, refusals removed, "references only"
no tracing                                      RAG_DEBUG trace per stage + eval script
```

Why each change improves accuracy:

| Change                  | Mechanism                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Embedding prefixes      | Aligns queries and passages the way the model was trained, so the gold chunk ranks higher.                               |
| Sentence-aware chunking | Facts and their headings stay together, and there are no half-words in embeddings or context.                            |
| Hybrid + RRF            | Exact tokens (numbers, names, IDs) are found even when the dense score is poor. The larger candidate pool raises recall. |
| Clean, ordered context  | The model reads coherent passages with page labels and no UUID noise.                                                    |
| Prompt + model + temp   | Fewer false refusals and hallucinations, and deterministic answers.                                                      |
| Memory hygiene          | One wrong answer no longer carries into later turns, and a bad rewrite can't remove the right chunk.                     |
| Tracing + eval          | Every failure can be attributed to a stage, and every change can be measured.                                            |

---

## 16. Exact Implementation Plan

Each step can be shipped and measured on its own. Run the eval (§18) before Step 1 to get a baseline,
and again after each step.

### Step 0 — Observability first (M5)

- **Problem:** there's no way to see which stage failed.
- **Files:** [rag.service.ts](../src/services/rag.service.ts), [env.ts](../src/config/env.ts), [types/env.ts](../src/types/env.ts), `.env.example`.
- **Change:** add a `RAG_DEBUG` boolean. When it's on, log the trace from §17.7.
- **Impact:** none on accuracy. It lets you diagnose every later step.
- **Test:** ask one question with `RAG_DEBUG=true` and confirm the log shows the query, chunk ids, scores, and the prompt.

### Step 1 — Embedding prefixes + reindex (C1)

- **Current:** `embed(text)` sends raw text for both documents and queries.
- **Why it hurts:** `nomic-embed-text` is trained on prefixed inputs. Without them, question-to-passage similarity is unreliable.
- **Files:** [embedding.service.ts](../src/services/embedding.service.ts), [retrieval.service.ts](../src/services/retrieval.service.ts), [ingest.worker.ts](../src/workers/ingest.worker.ts), env (3 places).
- **Details:** §17.1. Then reindex every document (Step 8).
- **Impact:** the largest single retrieval gain available.
- **Test:** Recall@5 on the eval set, before and after.

### Step 2 — Chat model, temperature, num_ctx (C2)

- **Files:** `.env`, `.env.example`, [env.ts](../src/config/env.ts) (defaults), [docker-compose.yml](../docker-compose.yml) (remove the three hard-coded `llama3.2:1b` values and use `${OLLAMA_CHAT_MODEL}`), [ollama.client.ts](../src/client/ollama.client.ts), [ollama.types.ts](../src/types/ollama.types.ts).
- **Details:** §17.2.
- **Impact:** far fewer false refusals and hallucinations when the right chunk _is_ retrieved.
- **Test:** answer correctness and refusal rate on the eval set.

### Step 3 — Prompt + context construction (C3, m1–m3)

- **Files:** [rag.service.ts](../src/services/rag.service.ts), [document-chunk.repository.ts](../src/repositories/document-chunk.repository.ts) (add `seq`), [tokenizer.service.ts](../src/services/tokenizer.service.ts) (reuse).
- **Details:** §17.4.
- **Test:** faithfulness and citation accuracy on the eval set.

### Step 4 — Chunking (M1) + table/hyphen normalization (M4, m4)

- **Files:** [chunking.service.ts](../src/services/chunking.service.ts), [text-normalizer.ts](../src/utils/text-normalizer.ts), `.env.example` (sizes).
- **Details:** §17.3. Reindex afterwards.
- **Test:** `GET /files/:id/chunks`. No chunk should start or end mid-word, and headings should stay with their content. Then run the eval.

### Step 5 — Hybrid retrieval (M2)

- **Files:** [document-chunk.repository.ts](../src/repositories/document-chunk.repository.ts), [retrieval.service.ts](../src/services/retrieval.service.ts), env (`RAG_CANDIDATE_K=20`, `RAG_CONTEXT_CHUNKS=6`).
- **Details:** §17.5.
- **Test:** Recall@6 and MRR, especially on the number, name, and date questions.

### Step 6 — Conversation hygiene (M3)

- **Files:** [condense.service.ts](../src/services/condense.service.ts), [rag.service.ts](../src/services/rag.service.ts), [conversation.service.ts](../src/services/conversation.service.ts).
- **Details:** §17.6.
- **Test:** multi-turn eval cases (§19, T17–T18).

### Step 7 — Embedding batching (m5)

- **Files:** [ingest.worker.ts](../src/workers/ingest.worker.ts) or [embedding.service.ts](../src/services/embedding.service.ts).
- **Test:** ingest a 100+ page PDF against the remote Ollama. It should reach `READY` with no retries.

### Step 8 — Reindex everything

After Steps 1 and 4, the existing vectors are stale. Reindex all documents:

```bash
# per document (existing endpoint)
curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/v1/documents/$ID/reindex
```

Or loop over `SELECT id FROM "Document" WHERE status = 'READY'` for each user.

### Step 9 (optional) — `Document.originalName` (m1)

This is an additive nullable column. Set it in `file.controller.ts` from `file.originalname`, return `originalName` from
the retrieval SQL, and use it in source labels. Skip it if schema changes are unwanted. The labels then fall back
to `Document 1…n`.

### Step 10 (conditional) — Reranker

Only if the eval shows Recall@20 ≫ Recall@6 after Steps 1–5 (see §11).

---

## 17. Code Changes

These snippets match the project's conventions (default-arg DI, `@` aliases, relative imports for
`src/client`, `HTTP_STATUS`, Prettier style). They are **proposals**. Nothing below has been applied yet.

### 17.1 Embedding prefixes — `src/services/embedding.service.ts`

```ts
import { env } from "@config/env";
import { OllamaService } from "@services/ollama.service";

const EMBED_BATCH_SIZE = 32;

export class EmbeddingService {
  constructor(private readonly ollamaService: OllamaService = new OllamaService()) {}

  // nomic-embed-text is trained on task-prefixed input; unprefixed text degrades retrieval.
  async embedQuery(text: string): Promise<number[]> {
    return this.ollamaService.embedText(`${env.RAG_EMBED_QUERY_PREFIX}${text}`);
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batch = texts
        .slice(i, i + EMBED_BATCH_SIZE)
        .map((text) => `${env.RAG_EMBED_DOCUMENT_PREFIX}${text}`);
      vectors.push(...(await this.ollamaService.embedMany(batch)));
    }
    return vectors;
  }
}
```

Env (add to the Zod schema, `src/types/env.ts`, and `.env.example`):

```ts
RAG_EMBED_QUERY_PREFIX: z.string().default("search_query: "),
RAG_EMBED_DOCUMENT_PREFIX: z.string().default("search_document: "),
```

Call sites: `retrieval.service.ts` → `embedQuery(input.query)`. `ingest.worker.ts:67` →
`embedDocuments(chunks.map((c) => c.text))`. `DocumentChunk.text` stays unprefixed.

### 17.2 Model options — `src/client/ollama.client.ts`

```ts
// ollama.types.ts
options?: { num_ctx?: number; temperature?: number; top_p?: number };

// ollama.client.ts (chat + chatStream)
options: {
  num_ctx: env.OLLAMA_NUM_CTX,
  temperature: env.OLLAMA_TEMPERATURE, // new env, default 0.1
  top_p: 0.9,
},
```

`.env` / `.env.example`: `OLLAMA_CHAT_MODEL=llama3.2:3b` (or `qwen2.5:7b-instruct`),
`OLLAMA_NUM_CTX=8192`, `OLLAMA_TEMPERATURE=0.1`.
`docker-compose.yml`: replace the literal `llama3.2:1b` in `ollama-pull-chat`, `api`, and `worker` with
`${OLLAMA_CHAT_MODEL:-llama3.2:3b}`.

### 17.3 Chunker — `src/services/chunking.service.ts`

Replace `slidingWindows` with a sentence- and heading-aware packer. `chunkPages`' page mapping stays
exactly as it is, and only the window source changes. (Tested on sample input. See §7.)

```ts
type Span = { start: number; end: number };

// Numbered ("4.", "4.2)"), markdown ("## "), or short capitalised lines without terminal punctuation.
const HEADING_PATTERN = /^(?:#{1,6}\s|\d+(?:\.\d+)*[.)]?\s+\S|[A-Z][A-Za-z0-9 &/,'()-]{0,78}:?$)/;

private isHeading(text: string, span: Span): boolean {
  const line = text.slice(span.start, span.end).trim();
  return line.length > 0 && line.length <= 80 && !/[.!?]$/.test(line) && HEADING_PATTERN.test(line);
}

/** Sentences, or whole lines when a line has no terminal punctuation; oversize atoms split at spaces. */
private atomize(text: string, maxLen: number): Span[] {
  const spans: Span[] = [];
  const re = /[^\n]*?(?:[.!?](?=\s)|\n|$)/g;
  let match: RegExpExecArray | null;
  while (re.lastIndex < text.length && (match = re.exec(text)) !== null) {
    if (match[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    const end = match.index + match[0].length;
    if (match[0].trim().length === 0) {
      continue;
    }
    let start = match.index;
    while (start < end) {
      let cut = Math.min(end, start + maxLen);
      if (cut < end) {
        const space = text.lastIndexOf(" ", cut);
        if (space > start) {
          cut = space + 1;
        }
      }
      spans.push({ start, end: cut });
      start = cut;
    }
  }
  return spans;
}

private *sentenceWindows(text: string, size: number, overlap: number): Generator<Span> {
  if (size <= 0) throw new Error("Chunk size must be positive.");
  if (overlap < 0 || overlap >= size) throw new Error("Chunk overlap must be >= 0 and < size.");
  const atoms = this.atomize(text, size);
  let i = 0;
  while (i < atoms.length) {
    let j = i;
    while (j + 1 < atoms.length && atoms[j + 1].end - atoms[i].start <= size) j += 1;
    // Never end on a heading: push it into the next chunk so it stays with its body.
    while (j > i && this.isHeading(text, atoms[j])) j -= 1;
    yield { start: atoms[i].start, end: atoms[j].end };
    if (j + 1 >= atoms.length) break;
    // Overlap = whole trailing sentences up to `overlap` chars.
    let k = j + 1;
    while (k - 1 > i && atoms[j].end - atoms[k - 1].start <= overlap) k -= 1;
    // If the overlap leaves no room for the next atom, drop it rather than emit a duplicate chunk.
    if (atoms[j + 1].end - atoms[k].start > size) k = j + 1;
    i = k;
  }
}
```

In `chunkPages` and `chunkText`, replace `this.slidingWindows(...)` with `this.sentenceWindows(...)`.
Set `RAG_CHUNK_SIZE=1000` and `RAG_CHUNK_OVERLAP=200`.

`src/utils/text-normalizer.ts`: add these before the `[ \t]+` collapse:

```ts
    .replace(/\r\n?/g, "\n")
    .replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2") // re-join words hyphenated across a line break
    .replace(/\t+/g, " | ") // pdf-parse separates table cells with \t; keep the column boundary
    .replace(/[ \t]+/g, " ")
```

### 17.4 Context + prompt — `src/services/rag.service.ts`

```ts
const NOT_FOUND = "I could not find this in your uploaded documents.";

const SYSTEM_PROMPT = [
  "You are IntelliDocs, an assistant that answers questions using the user's uploaded documents.",
  "",
  "Rules:",
  "1. Base every statement on the SOURCES in the user message. Do not use outside knowledge.",
  '2. The question may use different words than the document (e.g. "how long do I have to get my money back" vs "refund period is 30 days"). Read every source carefully before deciding.',
  "3. Copy numbers, dates, amounts, names and defined terms exactly as they appear.",
  "4. Cite the page after each fact, like (p.4). If sources come from more than one document, name the document too.",
  "5. If the sources contain part of the answer, give that part and say what is missing.",
  `6. Only if the sources contain nothing relevant, reply exactly: ${NOT_FOUND}`,
  "7. Earlier conversation turns are only for understanding what the user refers to; they are not a source of facts.",
  "Answer directly and concisely.",
].join("\n");

function buildUserPrompt(question: string, sources: string): string {
  return ["SOURCES:", sources, "", `QUESTION: ${question}`].join("\n");
}

/** Reading order, merged neighbours, no UUIDs, token-budgeted. */
function buildSources(
  chunks: RetrievedChunk[],
  budgetTokens: number,
  tokenizer: TokenizerService,
): string {
  const docLabels = new Map<string, string>();
  for (const c of chunks) {
    if (!docLabels.has(c.documentId)) {
      docLabels.set(c.documentId, c.documentName ?? `Document ${docLabels.size + 1}`);
    }
  }
  const ordered = [...chunks].sort((a, b) =>
    a.documentId === b.documentId ? a.seq - b.seq : a.documentId.localeCompare(b.documentId),
  );
  const blocks: string[] = [];
  let used = 0;
  for (const [index, chunk] of ordered.entries()) {
    const block = `[Source ${index + 1} | ${docLabels.get(chunk.documentId)} |${formatPageLabel(chunk.pageStart, chunk.pageEnd)}]\n${chunk.text}`;
    const cost = tokenizer.countTokens(block);
    if (used + cost > budgetTokens) break;
    used += cost;
    blocks.push(block);
  }
  return blocks.join("\n\n");
}
```

The chunks should be selected by relevance **before** `buildSources` runs, which only orders and trims them. The
budget should be `env.OLLAMA_NUM_CTX - historyTokens - 600`. Add `seq` (and optionally `documentName`)
to `RetrievedChunk` and to the `SELECT`. Merging consecutive `seq` chunks is optional: after the chunker
change, the overlap is at most 200 characters.

Messages:

```ts
messages: [
  { role: "system", content: SYSTEM_PROMPT },
  ...answerHistory, // ≤ 4 messages, refusals removed (17.6)
  { role: "user", content: buildUserPrompt(input.question, sources) },
],
```

### 17.5 Hybrid retrieval — `src/repositories/document-chunk.repository.ts`

```ts
async findHybrid(params: {
  userId: string;
  queryEmbedding: number[];
  queryText: string;
  candidateK: number; // 20
  limit: number;      // 6
  documentId?: string;
}): Promise<RetrievedChunk[]> {
  const vectorLiteral = `[${params.queryEmbedding.join(",")}]`;
  return prisma.$queryRawUnsafe<RetrievedChunk[]>(
    `
    WITH scope AS (
      SELECT c.id, c.embedding, c.text
      FROM "DocumentChunk" c
      JOIN "Document" d ON d.id = c."documentId"
      WHERE d."userId" = $2
        AND d.status = 'READY'
        AND ($3::text IS NULL OR d.id = $3::text)
    ),
    q AS (
      -- OR the lexemes: plainto_tsquery ANDs every word, which rarely matches a full question.
      SELECT NULLIF(replace(plainto_tsquery('english', $4)::text, '&', '|'), '')::tsquery AS tsq
    ),
    dense AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rnk
      FROM scope
      ORDER BY embedding <=> $1::vector
      LIMIT $5
    ),
    lexical AS (
      SELECT s.id,
             ROW_NUMBER() OVER (ORDER BY ts_rank_cd(to_tsvector('english', s.text), q.tsq) DESC) AS rnk
      FROM scope s, q
      WHERE q.tsq IS NOT NULL AND to_tsvector('english', s.text) @@ q.tsq
      ORDER BY ts_rank_cd(to_tsvector('english', s.text), q.tsq) DESC
      LIMIT $5
    ),
    fused AS (
      SELECT id, SUM(1.0 / (60 + rnk))::float8 AS rrf
      FROM (SELECT id, rnk FROM dense UNION ALL SELECT id, rnk FROM lexical) u
      GROUP BY id
    )
    SELECT c.id, c.text, c."documentId", c.seq, c."pageStart", c."pageEnd",
           (c.embedding <=> $1::vector)::float8 AS score,
           f.rrf
    FROM fused f
    JOIN "DocumentChunk" c ON c.id = f.id
    ORDER BY f.rrf DESC
    LIMIT $6
    `,
    vectorLiteral,
    params.userId,
    params.documentId ?? null,
    params.queryText,
    params.candidateK,
    params.limit,
  );
}
```

`RetrievalService.retrieveTopK` then becomes:

```ts
async retrieve(input: RetrieveInput): Promise<RetrievedChunk[]> {
  const limit = Math.max(1, Math.min(input.topK ?? env.RAG_CONTEXT_CHUNKS, 12));
  // Original + condensed question: a bad rewrite can no longer remove the right chunk.
  const queries = [...new Set([input.query, input.originalQuery].filter(Boolean))] as string[];
  const results = await Promise.all(
    queries.map(async (query) =>
      this.documentChunkRepository.findHybrid({
        userId: input.userId,
        queryEmbedding: await this.embeddingService.embedQuery(query),
        queryText: query,
        candidateK: env.RAG_CANDIDATE_K,
        limit,
        documentId: input.documentId,
      }),
    ),
  );
  // Keep the best RRF per chunk across queries.
  const best = new Map<string, RetrievedChunk>();
  for (const chunk of results.flat()) {
    const seen = best.get(chunk.id);
    if (!seen || chunk.rrf > seen.rrf) best.set(chunk.id, chunk);
  }
  return [...best.values()].sort((a, b) => b.rrf - a.rrf).slice(0, limit);
}
```

`score` is still the cosine distance, so `citations` keeps its meaning. Add `rrf: number` and `seq: number`
to `RetrievedChunk`.

### 17.6 Conversation hygiene

`src/services/condense.service.ts`:

```ts
const REFERENCE_PATTERN = /\b(it|its|that|this|these|those|they|them|their|he|she|his|her|same|above|previous|what about|and)\b/i;

async condense(history: ChatTurn[], question: string): Promise<string> {
  if (history.length === 0 || !REFERENCE_PATTERN.test(question)) {
    return question; // already standalone — never rewrite it
  }
  // ...existing call, with options { temperature: 0 }
}
```

`src/services/rag.service.ts` (history passed to the answer model):

```ts
function withoutRefusals(history: ChatTurn[]): ChatTurn[] {
  const kept: ChatTurn[] = [];
  for (let i = 0; i < history.length; i += 1) {
    const next = history[i + 1];
    if (
      history[i].role === "user" &&
      next?.role === "assistant" &&
      next.content.includes(NOT_FOUND)
    ) {
      i += 1; // drop the pair
      continue;
    }
    kept.push(history[i]);
  }
  return kept;
}

const answerHistory = withoutRefusals(history).slice(-4);
```

For `OllamaService.chat` to accept per-call options such as `temperature: 0`, add an optional
`options` parameter that's forwarded to the client.

### 17.7 Debug trace — `src/services/rag.service.ts` (Step 0)

```ts
if (env.RAG_DEBUG) {
  logger.info(
    {
      rag: {
        originalQuery: input.question,
        searchQuery,
        documentId,
        historyTurns: history.length,
        retrieved: retrieved.map((c) => ({
          id: c.id,
          documentId: c.documentId,
          seq: c.seq,
          pages: `${c.pageStart}-${c.pageEnd}`,
          distance: Number(c.score.toFixed(4)),
          rrf: c.rrf,
          preview: c.text.slice(0, 160),
        })),
        promptTokens: this.tokenizerService.countTokens(messages.map((m) => m.content).join("\n")),
        prompt: messages.at(-1)?.content,
      },
    },
    "RAG trace",
  );
}
```

Log the final answer in `ask()` and in `askStream().onComplete` under the same flag. Reading the trace:

```text
Gold text not in any DocumentChunk.text           → Ingestion / preprocessing
Gold text split across chunks / heading detached  → Chunking
Gold chunk exists but not in retrieved[]          → Embedding / retrieval (check prefix, K, FTS)
Gold chunk retrieved but low rank & cut by budget → Ranking / context budget
Gold chunk in prompt, answer wrong / refusal      → Prompt / LLM
Wrong only on follow-ups; searchQuery distorted   → Condense / memory
```

---

## 18. Evaluation Strategy

There's no test runner (see CLAUDE.md), so the evaluation is a **standalone script** in the same style as
`seed`: `scripts/rag-eval.ts`, run with `ts-node-dev --transpile-only -r tsconfig-paths/register`.
It calls `RetrievalService` and `RagService` directly for a dedicated eval user, so no HTTP or JWT
is involved.

### 18.1 Dataset format — `eval/dataset.json`

```json
[
  {
    "id": "T01",
    "type": "direct",
    "question": "What is the refund period?",
    "documentId": "<uuid of acme-handbook.txt or .pdf>",
    "goldPages": [1],
    "goldEvidence": ["refund period is 30 days"],
    "expectedAnswer": ["30 days"],
    "answerable": true
  }
]
```

- `goldEvidence`: a substring that must appear in a retrieved chunk (case- and whitespace-insensitive).
  This identifies the gold chunk without hard-coding chunk ids, so it survives re-chunking.
- `expectedAnswer`: key facts that must all appear in the answer (normalized substring match).

### 18.2 Metrics

For each question, `retrieved = [c1..cK]` in rank order, and `relevant(c)` = chunk text contains any `goldEvidence`.

| Metric             | Definition                                                                                                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hit@K / Recall@K   | Fraction of answerable questions with ≥1 relevant chunk in the top K. For multi-chunk questions, the fraction of distinct `goldEvidence` strings covered. Report K = 1, 3, 6, 20.                                                                    |
| Precision@K        | (# relevant chunks in the top K) / K, averaged.                                                                                                                                                                                                      |
| MRR                | Mean of `1 / rank of first relevant chunk` (0 if none).                                                                                                                                                                                              |
| Context relevance  | Fraction of chunks in the _final prompt_ that are relevant (low values mean noise). Use precision on the post-budget sources.                                                                                                                        |
| Answer correctness | All `expectedAnswer` facts appear in the answer (after normalizing numbers, e.g. "thirty" → "30").                                                                                                                                                   |
| Citation accuracy  | Every `(p.N)` in the answer is a page of a source that was actually in the prompt, and at least one matches `goldPages`.                                                                                                                             |
| Faithfulness       | Every factual sentence in the answer is supported by the provided sources. Measure with an LLM judge (a _stronger_ model than the generator, prompted with sources + answer → `SUPPORTED/UNSUPPORTED` per sentence), plus manual spot-checks on 20%. |
| Hallucination rate | Unanswerable questions: fraction **not** answered with the refusal sentence. Answerable questions: fraction with ≥1 unsupported sentence.                                                                                                            |
| False-refusal rate | Answerable questions answered with the refusal sentence. **This is the metric that captures "the answer exists but the system says it doesn't".**                                                                                                    |

### 18.3 Script sketch — `scripts/rag-eval.ts`

```ts
import { readFileSync } from "node:fs";
import { RetrievalService } from "@services/retrieval.service";
import { RagService } from "@services/rag.service";

type Case = {
  id: string;
  type: string;
  question: string;
  documentId?: string;
  goldEvidence: string[];
  expectedAnswer: string[];
  answerable: boolean;
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const NOT_FOUND = "i could not find this in your uploaded documents";
const USER_ID = process.env.EVAL_USER_ID!;
const K = [1, 3, 6, 20];

async function main() {
  const cases = JSON.parse(readFileSync("eval/dataset.json", "utf8")) as Case[];
  const retrieval = new RetrievalService();
  const rag = new RagService();
  const rows = [];
  for (const c of cases) {
    const chunks = await retrieval.retrieve({
      userId: USER_ID,
      query: c.question,
      topK: 20,
      documentId: c.documentId,
    });
    const relevant = chunks.map((ch) =>
      c.goldEvidence.some((g) => norm(ch.text).includes(norm(g))),
    );
    const firstRank = relevant.indexOf(true) + 1;
    const { answer } = await rag.ask({
      userId: USER_ID,
      question: c.question,
      documentId: c.documentId,
    });
    const refused = norm(answer).includes(NOT_FOUND);
    const correct = c.answerable
      ? !refused && c.expectedAnswer.every((e) => norm(answer).includes(norm(e)))
      : refused;
    rows.push({
      id: c.id,
      type: c.type,
      ...Object.fromEntries(K.map((k) => [`hit@${k}`, relevant.slice(0, k).some(Boolean)])),
      rr: firstRank ? 1 / firstRank : 0,
      topDistance: chunks[0]?.score.toFixed(3),
      falseRefusal: c.answerable && refused,
      pass: correct,
      answer: answer.slice(0, 120),
    });
  }
  console.table(rows);
  const answerable = rows.filter((_, i) => cases[i].answerable);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  console.log({
    ...Object.fromEntries(
      K.map((k) => [
        `recall@${k}`,
        mean(answerable.map((r) => Number(r[`hit@${k}` as keyof typeof r]))),
      ]),
    ),
    mrr: mean(answerable.map((r) => r.rr)),
    accuracy: mean(rows.map((r) => Number(r.pass))),
    falseRefusalRate: mean(answerable.map((r) => Number(r.falseRefusal))),
    hallucinationRateUnanswerable: mean(
      rows.filter((_, i) => !cases[i].answerable).map((r) => Number(!r.pass)),
    ),
  });
}
void main();
```

(`retrieve` is the Step 5 method. For the baseline, call the current `retrieveTopK` with `topK: 12`,
which is the current maximum.) Add `"eval:rag": "ts-node-dev --transpile-only -r tsconfig-paths/register scripts/rag-eval.ts"`
to package.json when implementing. Each `rag.ask` call creates a conversation for the eval user, which is
harmless and keeps eval data separate from real users.

---

## 19. Test Cases

The repo contains no sample documents, so here is a **fixture** that exercises every question type. Save it as
`eval/fixtures/acme-handbook.txt` (and ideally also as a two-page PDF with the table on page 2), upload it
with the eval user, and point the dataset at its `documentId`.

```text
ACME Cloud Customer Handbook
Version 3.2, effective 1 March 2025. Owner: Priya Raman, Head of Customer Operations.

1. Accounts
Each workspace may have up to 25 members on the Pro plan. The account owner can transfer
ownership once every 90 days.

2. Billing
Invoices are issued on the 1st of each month and are due within 15 days. Late payments incur
a fee of 2% per month. Invoice numbers follow the format INV-YYYY-NNNNN.

3. Support
Standard support is available Monday to Friday, 09:00-18:00 CET. Priority support tickets
receive a first response within 4 business hours. Escalations go to support-lead@acme.example.

4. Refund Policy
The refund period is 30 days from the date of purchase. Refunds are issued to the original
payment method within 10 business days of approval. Annual plans cancelled after the refund
period receive a pro-rated credit, not cash.

5. Data Retention
Deleted workspaces are kept for 60 days and then permanently erased. Backups are retained
for 35 days.

Plan    Price/month    Storage    Refund window
Basic   $10            50 GB      14 days
Pro     $25            500 GB     30 days
```

| ID  | Type                      | Question                                                                     | Expected answer                     | Gold evidence (substring)                  | Answerable |
| --- | ------------------------- | ---------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------ | ---------- |
| T01 | Direct factual            | What is the refund period?                                                   | 30 days                             | `refund period is 30 days`                 | yes        |
| T02 | Direct factual            | How long are backups retained?                                               | 35 days                             | `retained for 35 days`                     | yes        |
| T03 | Different wording         | How many days do I have to request a refund?                                 | 30 days                             | `refund period is 30 days`                 | yes        |
| T04 | Different wording         | How quickly will someone reply to an urgent support ticket?                  | within 4 business hours             | `within 4 business hours`                  | yes        |
| T05 | Number                    | How many members can a Pro workspace have?                                   | 25                                  | `up to 25 members`                         | yes        |
| T06 | Number                    | What is the late payment fee?                                                | 2% per month                        | `2% per month`                             | yes        |
| T07 | Number (table)            | How much storage does the Basic plan include?                                | 50 GB                               | `50 GB`                                    | yes        |
| T08 | Date                      | When did version 3.2 of the handbook take effect?                            | 1 March 2025                        | `effective 1 March 2025`                   | yes        |
| T09 | Date                      | On what day of the month are invoices issued?                                | the 1st                             | `issued on the 1st`                        | yes        |
| T10 | Name                      | Who owns the customer handbook?                                              | Priya Raman                         | `Priya Raman`                              | yes        |
| T11 | Name / exact token        | What email handles support escalations?                                      | support-lead@acme.example           | `support-lead@acme.example`                | yes        |
| T12 | Policy                    | What happens if I cancel an annual plan after the refund period?             | pro-rated credit, not cash          | `pro-rated credit`                         | yes        |
| T13 | Policy                    | How often can workspace ownership be transferred?                            | once every 90 days                  | `once every 90 days`                       | yes        |
| T14 | Multi-chunk               | How long until a deleted workspace is erased, and how long are backups kept? | 60 days; 35 days                    | `kept for 60 days`, `retained for 35 days` | yes        |
| T15 | Multi-chunk (text+table)  | What is the refund window for Basic compared to the standard refund period?  | 14 days vs 30 days                  | `Basic`, `refund period is 30 days`        | yes        |
| T16 | Not in document           | Does ACME offer phone support on weekends?                                   | refusal sentence                    | —                                          | **no**     |
| T17 | Not in document           | What is the price of the Enterprise plan?                                    | refusal sentence                    | —                                          | **no**     |
| T18 | Follow-up (turn 2 of T01) | "And how long does it take to get the money back?"                           | within 10 business days of approval | `within 10 business days`                  | yes        |
| T19 | Follow-up after a refusal | T16, then "What are the standard support hours?"                             | Monday–Friday, 09:00–18:00 CET      | `09:00-18:00 CET`                          | yes        |

T15 and T07 specifically exercise the table fix (M4). T11 and T06 exercise hybrid FTS (exact tokens).
T18 and T19 exercise the memory fixes (M3). T03 and T04 exercise embedding prefixes (C1) plus the prompt (C3).

Also add **10–20 questions from your real documents** in the same format. The fixture proves the pipeline works.
Your real documents show whether it works for your content.

---

## 20. Expected Results

I haven't measured these numbers, because the database, Docker, and Ollama were not reachable during the investigation.
Record the baseline first. Qualitatively, expect:

| Step                  | Metric most affected                     | Expected direction  |
| --------------------- | ---------------------------------------- | ------------------- |
| 1 Prefixes            | Recall@6, MRR (T03, T04)                 | Large increase      |
| 2 Model/temp          | False-refusal rate, faithfulness         | Large improvement   |
| 3 Prompt/context      | False-refusal rate, citation accuracy    | Moderate            |
| 4 Chunking/normalizer | Answer correctness on T07, T12, T15      | Moderate            |
| 5 Hybrid              | Recall@6 on T06, T09, T11 (exact tokens) | Moderate–large      |
| 6 Memory              | T18, T19                                 | Fixes contamination |

Targets for "fixed": Recall@6 ≥ 0.9 and answer accuracy ≥ 0.85 on the fixture, false-refusal rate ≤ 5%,
correct refusals on T16/T17, and T19 answered correctly after a refusal.

---

## 21. Debugging Checklist

Work top-down and stop at the first stage that fails.

```sql
-- 1. Did ingestion finish?
SELECT id, status, error, warning, "updatedAt" FROM "Document" WHERE "userId" = '<user>';

-- 2. Is the answer text in the index at all? (ingestion / preprocessing)
SELECT seq, "pageStart", "pageEnd", left(text, 200)
FROM "DocumentChunk" WHERE "documentId" = '<doc>' AND text ILIKE '%30 days%';

-- 3. Is it split badly? (chunking) — inspect neighbours
SELECT seq, left(text, 80) AS head, right(text, 80) AS tail
FROM "DocumentChunk" WHERE "documentId" = '<doc>' AND seq BETWEEN <n-1> AND <n+1> ORDER BY seq;

-- 4. Which vector index exists? (expect none today, or an HNSW index after §9)
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'DocumentChunk';
SELECT extversion FROM pg_extension WHERE extname = 'vector';

-- 5. Would FTS find it? (hybrid)
SELECT seq, ts_rank_cd(to_tsvector('english', text),
       replace(plainto_tsquery('english', 'How many days to request a refund')::text, '&', '|')::tsquery) AS r
FROM "DocumentChunk" WHERE "documentId" = '<doc>' ORDER BY r DESC LIMIT 5;

-- 6. Are vectors stale? (chunk createdAt older than the prefix deploy ⇒ reindex)
SELECT "documentId", min("createdAt") FROM "DocumentChunk" GROUP BY 1;
```

```bash
# 7. Does the prefix change the ranking? Compare with and without it.
curl -s $OLLAMA_BASE_URL/api/embed -d '{"model":"nomic-embed-text","input":["search_query: How many days do I have to request a refund?"]}'
```

8. Set `RAG_DEBUG=true`, ask the question, and apply the stage table at the end of §17.7.
9. If the gold chunk is in `prompt` but the answer is wrong, re-run with a larger chat model. If that fixes it, the cause is the model, not retrieval.
10. If only follow-ups fail, compare `originalQuery` and `searchQuery` in the trace.

---

## 22. Production Considerations

- **Reindex migration:** any change to the prefix, embedding model, chunker, or normalizer invalidates vectors. Consider an
  `ingestionVersion` (already in the reindex payload) stored on `Document`, and reindex documents whose
  version is lower than the current one.
- **Indexes vs Prisma:** hand-written pgvector and GIN indexes get dropped by `prisma migrate dev`. Review every generated migration.
- **Latency:** hybrid search adds one CTE, which is negligible at this scale. A 7B model on CPU is slow, so stream
  (`/ask/stream` already exists) and size the Ollama host accordingly. Keep embedding and chat on the same host to avoid
  cross-network calls through ngrok.
- **Context limits:** raising `num_ctx` increases memory use in Ollama. Verify it on the actual host.
- **Security:** the new SQL keeps the `d."userId" = $2` predicate, so ownership is still enforced. All inputs are
  bound parameters (no string interpolation of user text).
- **Monitoring:** log `topDistance`, the number of retrieved chunks, prompt tokens, and whether the answer was a refusal on every request.
  A rising refusal rate is the earliest signal of a retrieval regression.

---

## 23. Before vs After

| Area             | Before                                               | After                                                          |
| ---------------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| Tables           | Cells merged with spaces                             | Cells separated by `\|`                                        |
| Chunk boundaries | Fixed 900 chars, mid-word cuts                       | Whole sentences, headings kept with their body, 1000/200       |
| Embeddings       | Raw text, 1 request per document                     | `search_document:` / `search_query:` prefixes, batches of 32   |
| Retrieval        | Dense top-5                                          | Dense top-20 ∪ FTS top-20 → RRF → top-6                        |
| Query            | Condensed only (1B, temp 0.8)                        | Original + condensed, condensed only when needed, temp 0       |
| Context          | `[chunk_i] (uuid/uuid p.N)`, distance order          | `[Source i \| name \| p.N]`, reading order, token-budgeted     |
| Prompt           | Question before context, refusal-primed              | Sources → question, paraphrase and exact-value rules           |
| Model            | llama3.2:1b, temp 0.8, 4k ctx                        | ≥ llama3.2:3b (qwen2.5:7b ideal), temp 0.1, 8k ctx             |
| Memory           | 10 msgs verbatim, refusals replayed                  | Last 4 msgs, refusals removed, used only to resolve references |
| Observability    | None                                                 | `RAG_DEBUG` trace + `eval:rag` script                          |
| Vector index     | Accidentally dropped. Old ivfflat would hurt recall. | Exact scan now, HNSW + iterative scan when needed              |

---

## 24. Final Recommendations

1. **Do Step 0 (tracing) and record a baseline** with the §19 dataset before changing anything else.
2. **Steps 1 and 2 first.** Embedding prefixes plus a stronger, low-temperature model are the cheapest changes
   and address the two critical failure paths directly. Reindex after Step 1.
3. **Then Steps 3–5** (prompt/context, chunking/normalizer, hybrid). Reindex after Step 4.
4. **Step 6** before relying on multi-turn chat.
5. **Only add a reranker** if Recall@20 ≫ Recall@6 after Step 5.
6. **Do not add** HyDE, multi-query, parent-child, agentic, or graph RAG. Nothing in this codebase or its document types
   calls for them, and with a local model they would add distortion and latency.

### Files that change

| File                                                                                                                                                                          | Steps                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `src/services/embedding.service.ts`                                                                                                                                           | 1, 7                 |
| `src/services/retrieval.service.ts`                                                                                                                                           | 1, 5, 6              |
| `src/workers/ingest.worker.ts`                                                                                                                                                | 1, 7                 |
| `src/client/ollama.client.ts`, `src/types/ollama.types.ts`                                                                                                                    | 2, 6                 |
| `src/services/ollama.service.ts`                                                                                                                                              | 6 (per-call options) |
| `src/services/rag.service.ts`                                                                                                                                                 | 0, 3, 6              |
| `src/repositories/document-chunk.repository.ts`                                                                                                                               | 3, 5                 |
| `src/services/chunking.service.ts`                                                                                                                                            | 4                    |
| `src/utils/text-normalizer.ts`                                                                                                                                                | 4                    |
| `src/services/condense.service.ts`                                                                                                                                            | 6                    |
| `src/config/env.ts`, `src/types/env.ts`, `.env.example`, `.env`                                                                                                               | 0, 1, 2, 5           |
| `docker-compose.yml`                                                                                                                                                          | 2                    |
| `scripts/rag-eval.ts`, `eval/dataset.json`, `eval/fixtures/*` (new)                                                                                                           | eval                 |
| `package.json` (`eval:rag` script only)                                                                                                                                       | eval                 |
| _(optional)_ `prisma/schema.prisma` + additive migration, `src/controllers/file.controller.ts`, `src/services/document.service.ts`, `src/repositories/document.repository.ts` | 9                    |

API response shapes, auth, routes, and the frontend contract stay the same. `citations[].score` is still cosine distance.
