# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

IntelliDocs — a RAG backend. Users upload PDF/TXT files, which are parsed, chunked, embedded, and stored in Postgres + pgvector; `/ask` retrieves top-K chunks and answers with a local Ollama model, citing page numbers.

Package manager is **pnpm** (see `packageManager` in package.json). Node >= 22.

## Commands

```bash
pnpm install                # postinstall runs prisma generate
pnpm run dev                # API server, ts-node-dev, port 4000
pnpm run worker:ingest      # ingest worker — must run separately from the API
pnpm run build              # prisma generate + tsc + tsc-alias
pnpm run typecheck          # prisma generate + tsc --noEmit
pnpm run lint               # eslint (type-checked rules; needs a valid tsconfig project)
pnpm run lint:fix
pnpm run format             # prettier
pnpm run prisma:migrate     # prisma migrate dev
pnpm run prisma:studio
pnpm run seed               # upserts admin@example.com
docker compose up --build   # api + worker + pgvector + ollama (pulls models) + rabbitmq
```

**There is no test suite and no test runner installed.** Don't invent `pnpm test`; verification is `pnpm run lint && pnpm run typecheck && pnpm run build`.

Husky runs `lint-staged`, `lint`, `typecheck`, and `build` on **pre-commit** and `lint`/`typecheck`/`build` on **pre-push**, so a type error blocks committing. Commit messages are enforced by commitlint (conventional commits); `pnpm run commit` uses cz-git.

Local Postgres runs on **5433** (compose maps 5433→5432) and must be the `pgvector/pgvector` image — plain Postgres will fail the `vector` extension migration.

## Architecture

### Two processes, one codebase

- **API** ([src/server.ts](src/server.ts) → [src/app.ts](src/app.ts)): all routes mounted under `/api/v1` via [src/routes/index.ts](src/routes/index.ts).
- **Ingest worker** ([src/workers/ingest.worker.ts](src/workers/ingest.worker.ts)): same repo, separate entry point guarded by `require.main === module`. Uploading a file only enqueues work — nothing is indexed unless the worker is running.

### Layering

`routes → middlewares (validate/auth) → controllers → services → repositories → prisma`. Controllers are thin `asyncHandler`-wrapped functions; services own the logic and are constructed with default-argument dependency injection (`constructor(private readonly x: X = new X())`), which is how they'd be stubbed in a test.

### Ingestion pipeline

`POST /api/v1/files/upload` → B2 (S3-compatible) upload → `Document` row (`PENDING`) → `IngestProducer` publishes to RabbitMQ → worker:

1. `markProcessing` → download from B2 → [FileParserService](src/services/file-parser.service.ts) returns **per-page** text (`ParsedPage[]`; TXT is a single page 1).
2. [normalizeText](src/utils/text-normalizer.ts) per page, then [detectScannedPages](src/utils/scanned-page-detector.ts) classifies pages with too few letters/digits (`RAG_MIN_PAGE_TEXT_CHARS`) as scanned. Above `RAG_MAX_SCANNED_PAGE_RATIO` the document is unindexable; otherwise the readable pages are indexed and a `Document.warning` records which pages were skipped.
3. [ChunkingService.chunkPages](src/services/chunking.service.ts) joins pages into one string so overlap crosses page breaks, then maps each chunk back to a `pageStart`/`pageEnd` range — that's what powers `(p.4)` citations in answers.
4. Embed via Ollama, delete existing chunks, re-insert, `markReady(warning)`.

`Document.status` (`PENDING/PROCESSING/READY/FAILED`) is the ingestion state machine; retrieval only reads chunks of `READY` documents. `POST /documents/:id/reindex` resets to `PENDING` and re-enqueues.

**Error semantics matter here.** [PermanentIngestError](src/utils/ingest-error.ts) (unsupported mime, no text layer, zero chunks) is nacked straight to the DLQ; anything else is retried by **republishing the message** with an incremented `retryCount` header after exponential backoff, then acking the original (see the consumer at the bottom of the worker). Throw `PermanentIngestError` for anything a retry cannot fix.

### pgvector access

`DocumentChunk.embedding` is `Unsupported("vector(768)")` in Prisma, so **all embedding reads/writes use raw SQL** in [src/repositories/document-chunk.repository.ts](src/repositories/document-chunk.repository.ts) (`$executeRawUnsafe` upsert on `(documentId, seq)`, `$queryRawUnsafe` with `<=>` cosine distance). `score` is a **distance — lower is better**, not a similarity.

The 768 dimension is tied to `nomic-embed-text`. Changing `OLLAMA_EMBED_MODEL` requires a migration altering the column type and re-embedding every chunk. Text is embedded with the model's task prefixes (`RAG_EMBED_QUERY_PREFIX` / `RAG_EMBED_DOCUMENT_PREFIX`, applied in [EmbeddingService](src/services/embedding.service.ts) only, never stored); changing a prefix, the chunker, or the normalizer makes every stored vector stale, so reindex all documents via `POST /documents/:id/reindex`. The `vector` extension and the HNSW cosine index (`DocumentChunk_embedding_hnsw_cos_idx`) are created in hand-written SQL inside `prisma/migrations/`; keep that pattern rather than expecting `prisma migrate` to generate them. **Prisma does not know about that index, so every migration `prisma migrate dev` generates will contain a `DROP INDEX` for it — delete that line before applying** (migration `20260924083636_y` lost the index this way). The search query runs `SET LOCAL hnsw.iterative_scan = relaxed_order` so the per-user filter cannot starve results; this needs pgvector >= 0.8, which the `restore_chunk_vector_index` migration asserts.

### Response envelope

Every handler returns `{ isSuccess, status, message?, data?, error? }` via [sendSuccess/sendError](src/utils/api-response.ts). Throw `AppError(message, HTTP_STATUS.X)` from services; [errorHandler](src/middlewares/error-handler.ts) maps `AppError`, `MulterError`, `ZodError`, and Prisma `P2002` to the envelope. Use the `HTTP_STATUS` constants, not numeric literals.

Exception to know about: [validate-request](src/middlewares/validate-request.ts) responds with `{ message, errors[] }` directly, bypassing the envelope, and [health.route](src/routes/health.route.ts) builds its `/ready` body inline so it can return 503. Reuse `sendSuccess` for new endpoints.

### Auth

Bearer JWT; `requireAuth` verifies and populates `req.user` (typed in [src/types/express.d.ts](src/types/express.d.ts)). Applied per-router in `routes/index.ts` and per-route in `rag.route.ts`. **`/users` is currently mounted without `requireAuth`** — a known gap tracked in [ROADMAP.md](ROADMAP.md), along with the no-op sign-out, missing streaming, and missing chat memory. Check ROADMAP before proposing features; it reflects deliberate priorities.

Ownership is enforced in controllers/queries (`getByIdAndUserId`, the `d."userId" = $2` predicate in the vector search) — any new document/chunk access path must scope by `req.user.id` the same way.

### Config

[src/config/env.ts](src/config/env.ts) validates all env vars with Zod at import time and **throws on startup** if anything is missing — including deriving `B2_S3_REGION` from `B2_ENDPOINT` (Backblaze regions must include the numeric suffix, e.g. `us-east-005`). Add new env vars in three places: the Zod schema, [src/types/env.ts](src/types/env.ts), and `.env.example`.

Prisma uses the `@prisma/adapter-pg` driver adapter with a global singleton in dev ([src/config/prisma.ts](src/config/prisma.ts)); `sslmode=disable` in `DATABASE_URL` disables TLS for the local container.

## Conventions

- TypeScript strict; ESLint runs `recommendedTypeChecked`, so `no-floating-promises` and `no-misused-promises` are errors — `void` deliberate fire-and-forget promises.
- Path aliases (`@config/*`, `@services/*`, `@utils/*`, …) resolve via `tsconfig-paths` at dev time and `tsc-alias` at build time. Two directories have **no working alias** and are imported relatively everywhere: `src/queue/*` (no alias defined) and `src/client/*` (the `@clients/*` alias points at a non-existent `src/clients`). Follow the existing relative imports there instead of adding an alias import that won't resolve.
- Prettier: double quotes, semicolons, trailing commas, 100-char width.
