# IntelliDocs — Roadmap & Missing Features

This document tracks gaps and planned improvements to take the RAG backend from
"functional" to "production-grade." Items are grouped by priority.

Legend: 🔴 critical · 🟢 high-impact feature · 🟡 production-readiness · 🐛 correctness

---

## 🔴 Critical gaps (fix first — safety / correctness)

### 1. `/users` routes are unprotected

In [`src/routes/index.ts`](src/routes/index.ts), `/files` and the RAG routes use
`requireAuth`, but `/users` is mounted with **no authentication**:

```ts
router.use("/users", userRouter); // ⚠️ no requireAuth
```

Anyone can list, create, update, or **delete any user** without a token.

- [ ] Add `requireAuth` to the users router.
- [ ] Add a `requireRole("admin")` middleware (the `Role` enum already exists in Prisma).

### 2. Sign-out is a no-op

[`src/controllers/auth.controller.ts`](src/controllers/auth.controller.ts) only tells the
client to "discard the token." A stolen/leaked JWT stays valid until it expires.

- [ ] Implement **refresh-token rotation** + revocation (stored refresh tokens or a denylist).
- [ ] Move tokens to `httpOnly` cookies.

---

## 🟢 Next-level features (the visible product jump)

### 3. Streaming answers (SSE)

`RagService.ask()` in [`src/services/rag.service.ts`](src/services/rag.service.ts) blocks
until the full LLM response is ready. Ollama supports `stream: true`.

- [ ] Stream tokens to the client via **Server-Sent Events** so answers render word-by-word.

### 4. Conversational chat sessions (memory)

`/ask` is currently stateless single-shot Q&A — follow-ups like _"and its pricing?"_ have
no context.

- [ ] Add `Conversation` + `Message` tables.
- [ ] Feed prior turns into the prompt.
- [ ] Add a **query-condensing** step (rewrite a follow-up into a standalone question before retrieval).

### 5. Hybrid search + reranking

Retrieval is pure vector top-K today. This is the biggest lever on answer quality.

- [ ] **Hybrid search**: combine pgvector similarity with Postgres full-text (BM25-style) search.
- [ ] **Reranking**: retrieve top ~20, rerank to top ~5 with a cross-encoder (or Cohere / Ollama rerank).

---

## 🟡 Production-readiness

- [ ] **Real readiness health check** — [`src/routes/health.route.ts`](src/routes/health.route.ts)
      returns a static `{ status: "ok" }`; it should actually ping Postgres, RabbitMQ, and Ollama.
- [ ] **Document lifecycle** — add delete-document that cascades to chunks + the B2 object;
      paginated listing with ingestion status.
- [ ] **Per-user rate limits & quotas** on `/ask` and `/upload` (the global limiter is
      `1000 / 15 min` for everyone — expensive LLM endpoints need tighter, per-user caps).
- [ ] **Real-time ingestion status** — push `processing → ready` updates via SSE/WebSocket
      instead of client polling.
- [ ] **Observability** — request tracing + Prometheus metrics (ingest / embed / retrieval
      latency, queue depth).
- [ ] **Tests + CI** — no test suite currently; add integration tests for the auth and RAG flows.
- [ ] **OpenAPI / Swagger docs** — generate from the existing Zod validators (e.g. `zod-to-openapi`).

---

## 🐛 Correctness notes

- [`src/workers/ingest.worker.ts`](src/workers/ingest.worker.ts) stores
  `tokenCount: chunkText.length` — that's a **character** count, not tokens. Use a real
  tokenizer if you budget context by tokens.

---

## Infrastructure decision (deferred)

Queue technology — **keep RabbitMQ** vs. migrate to **pg-boss** (reuses existing Postgres,
removes a container) or **BullMQ** (Redis). Current usage is a single job type with hand-rolled
retry/backoff, so RabbitMQ is mildly over-provisioned but not wrong. Decision postponed.

---

## Suggested order

1. Fix `/users` auth (🔴 quick + important)
2. Streaming answers / SSE (🟢)
3. Conversational chat memory (🟢)
4. Refresh tokens (🔴)
5. Hybrid search + reranking (🟢)
