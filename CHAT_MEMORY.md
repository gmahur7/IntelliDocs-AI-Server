# Conversational Chat Memory — Implementation Guide

How to add per-user, per-chat memory to IntelliDocs, step by step.

This is ROADMAP item 4. Follow the steps in order — each one compiles on its own, so you can run
`pnpm run typecheck` after every step and catch mistakes early instead of at the end.

---

## 1. What you are building, and why

Today `/ask` is stateless. Every request is a fresh question with no idea what came before:

```
You: "What does the Acme contract say about termination?"
Bot: "Either party may terminate with 30 days notice. (p.12)"

You: "And the penalty for that?"
Bot: "I could not find this in your uploaded documents."   ← no idea what "that" means
```

The failure has **two separate causes**, and you must fix both. This trips people up, so be clear
on it before writing any code:

| Problem                                             | What breaks                                                                 | Fix                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| The model never sees the earlier turns              | It can't understand "that"                                                  | **Feed history into the prompt**                                       |
| `"And the penalty for that?"` is what gets embedded | The vector search matches nothing useful — that sentence has no topic words | **Condense the follow-up into a standalone question before retrieval** |

Fixing only the first one is the classic mistake. The model would understand the question but still
get handed garbage chunks, because retrieval ran on the pronoun-laden text. You need both.

### Target flow

```
POST /api/v1/ask  { conversationId, question: "And the penalty for that?" }
        │
        ├─ 1. Load conversation, verify it belongs to req.user.id      ← per-user isolation
        ├─ 2. Load last N messages of THAT conversation                ← per-chat isolation
        ├─ 3. Condense: history + question -> "What is the penalty for terminating
        │                                      the Acme contract early?"
        ├─ 4. Retrieve top-K chunks using the CONDENSED question
        ├─ 5. Build messages: [system, ...history, grounded prompt with the ORIGINAL question]
        ├─ 6. Generate answer (streaming or not)
        └─ 7. Save the user turn + assistant turn to the conversation
```

Two independent scoping rules, both mandatory:

- **Per user** — every conversation lookup filters on `userId`, exactly like
  `getByIdAndUserId` in [src/services/document.service.ts](src/services/document.service.ts).
  Never trust a `conversationId` from the request body on its own.
- **Per chat** — history only ever loads messages of the one conversation being asked about.

### Backward compatibility

`conversationId` will be **optional**. Leave it out and `/ask` behaves exactly as it does today
(stateless, no DB writes). This means you can ship the schema and the endpoints without breaking
the existing frontend, and adopt memory when you're ready.

---

## 2. Step 1 — Database schema

### 2.1 Edit `prisma/schema.prisma`

Add the enum and two models, and add the back-relation to `User`.

```prisma
enum MessageRole {
  USER
  ASSISTANT
}

model Conversation {
  id         String    @id @default(uuid())
  userId     String
  user       User      @relation(fields: [userId], references: [id])
  title      String?
  documentId String?
  createdAt  DateTime  @default(now())
  updatedAt  DateTime  @updatedAt
  messages   Message[]

  @@index([userId, updatedAt])
}

model Message {
  id             String       @id @default(uuid())
  conversationId String
  conversation   Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  userId         String
  role           MessageRole
  content        String
  citations      Json?
  tokenCount     Int?
  createdAt      DateTime     @default(now())

  @@index([conversationId, createdAt])
}
```

And inside `model User`, next to `documents Document[]`:

```prisma
  conversations Conversation[]
```

**Why each field is there — do not skip this, several are load-bearing:**

- `Conversation.documentId` (nullable) — lets a chat be pinned to one document, so every turn
  searches only that file without the client resending it. `null` means search all the user's docs.
- `Conversation.updatedAt` + the `@@index([userId, updatedAt])` — this is what makes
  "my chats, most recent first" a fast index scan instead of a sort over every row. Bump
  `updatedAt` on every new message.
- `Message.userId` is **denormalized** (it's already reachable via `conversation.userId`). It is
  there so an ownership check is a single-table query, matching how `DocumentChunk` also carries
  `userId`. Keep it consistent with the parent conversation; never set it from the request body
  directly — set it from `req.user.id`.
- `Message.citations Json?` — assistant turns store the `RagCitation[]` they were built from, so
  reopening an old chat still shows its page citations without re-running retrieval. `null` for
  user turns.
- `Message.tokenCount` — filled with `TokenizerService`, so the history budget in Step 5 is a sum
  of stored integers rather than re-tokenizing the whole history on every request.
- `onDelete: Cascade` on the conversation relation — deleting a chat deletes its messages. Without
  it, Postgres refuses the delete with a foreign-key error.

### 2.2 Generate the migration

```bash
pnpm run prisma:migrate
```

When prompted, name it `add_conversation_and_message`.

These are ordinary relational tables, so unlike the pgvector migrations you do **not** hand-write
SQL here — let Prisma generate it. (The hand-written-SQL rule in CLAUDE.md applies only to the
`vector` extension, the `ivfflat` index, and the embedding column.)

Verify it worked:

```bash
pnpm run prisma:studio     # you should see empty Conversation and Message tables
```

---

## 3. Step 2 — Configuration

### 3.1 The context-window trap (read this before you add anything)

[src/client/ollama.client.ts](src/client/ollama.client.ts) sends `options: { num_ctx: 2048 }` on
every chat call. That is the model's **entire** working memory — system prompt, retrieved chunks,
history, question, and the answer it is generating, all inside 2048 tokens.

Do the arithmetic for a default request today:

```
5 chunks × 900 chars ≈ 4500 chars ≈ ~1200 tokens   (retrieved context)
prompt scaffolding + question                       ≈ ~150 tokens
                                                    ─────────────
                                                    ≈ 1350 tokens used, ~700 left for the answer
```

You are already close to the ceiling. Add 1500 tokens of history and Ollama will silently discard
the **oldest** part of the prompt to make room — and the oldest part is your system instructions and
retrieved chunks. The symptom is maddening: answers get vaguer and stop citing pages, with no error
anywhere. Nothing logs a warning.

So raising `num_ctx` is a required part of this feature, not an optimization.

Make it configurable and default it to `4096`. `llama3.2` supports up to 128k, but every increase
costs RAM and latency, so move up deliberately: `4096` is right for 5 chunks plus ~6 history turns.

### 3.2 Add three env vars, in three places

CLAUDE.md requires each new variable in **all three** of these, or the app throws at startup.

**(a) `src/config/env.ts`** — in the Zod schema, next to the other `RAG_*` entries:

```ts
  OLLAMA_NUM_CTX: z.coerce.number().int().positive().default(4096),
  RAG_MAX_HISTORY_MESSAGES: z.coerce.number().int().nonnegative().default(10),
  RAG_MAX_HISTORY_TOKENS: z.coerce.number().int().nonnegative().default(1200),
```

**(b) `src/types/env.ts`** — in the `EnvironmentVariables` interface:

```ts
OLLAMA_NUM_CTX: number;
RAG_MAX_HISTORY_MESSAGES: number;
RAG_MAX_HISTORY_TOKENS: number;
```

**(c) `.env.example`**:

```dotenv
OLLAMA_NUM_CTX=4096
RAG_MAX_HISTORY_MESSAGES=10
RAG_MAX_HISTORY_TOKENS=1200
```

`RAG_MAX_HISTORY_MESSAGES` is a **turn count** cap and `RAG_MAX_HISTORY_TOKENS` is a **size** cap.
You want both: ten one-line turns are cheap, but ten turns that each quote a paragraph are not.
Whichever limit trips first wins.

### 3.3 Use `num_ctx` in the client

In [src/client/ollama.client.ts](src/client/ollama.client.ts), both `chat()` and `chatStream()`
currently hardcode `num_ctx: 2048`. Replace both with the env value:

```ts
options: {
  num_ctx: env.OLLAMA_NUM_CTX,
},
```

Don't forget `chatStream()` — it's easy to change only the first one and then wonder why streamed
answers behave differently from non-streamed ones.

---

## 4. Step 3 — Types

In [src/types/rag.types.ts](src/types/rag.types.ts), add:

```ts
export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
};

export type ConversationSummary = {
  id: string;
  title: string | null;
  documentId: string | null;
  createdAt: Date;
  updatedAt: Date;
};
```

And extend the two existing result types so callers learn which conversation an answer landed in
(the client needs this when the conversation was created implicitly):

```ts
export type AskQuestionResponse = {
  answer: string;
  citations: RagCitation[];
  conversationId?: string;
};

export type RagStreamResult = {
  citations: RagCitation[];
  tokens: AsyncIterable<string>;
  conversationId?: string;
  onComplete?: (answer: string) => Promise<void>;
};
```

`onComplete` is the important one, and the reason is worth understanding now rather than in Step 8.

In the streaming path the full answer does not exist until the last token has been sent. The
controller is the only place that sees every token, but **saving to the database is a service-layer
job** — controllers in this codebase are thin. So the service hands back a callback: the controller
accumulates the text, then calls `onComplete(fullAnswer)` and the service does the persisting. The
controller never touches a repository.

---

## 5. Step 4 — Repository

Create `src/repositories/conversation.repository.ts`, following the shape of
[document.repository.ts](src/repositories/document.repository.ts) — thin methods, Prisma only,
no business logic:

```ts
import { prisma } from "@config/prisma";
import { MessageRole, Prisma } from "@prisma/client";

export type MessageCreateFields = {
  conversationId: string;
  userId: string;
  role: MessageRole;
  content: string;
  citations?: Prisma.InputJsonValue;
  tokenCount?: number;
};

export class ConversationRepository {
  async create(data: { userId: string; title?: string; documentId?: string }) {
    return prisma.conversation.create({ data });
  }

  async findByIdAndUserId(id: string, userId: string) {
    return prisma.conversation.findFirst({ where: { id, userId } });
  }

  async findManyByUserId(userId: string) {
    return prisma.conversation.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
    });
  }

  async deleteByIdAndUserId(id: string, userId: string) {
    return prisma.conversation.deleteMany({ where: { id, userId } });
  }

  /** Oldest-first, capped to the most recent `limit` turns. */
  async findRecentMessages(conversationId: string, limit: number) {
    const rows = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.reverse();
  }

  async findAllMessages(conversationId: string) {
    return prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
    });
  }

  /** Writes both turns and bumps updatedAt atomically. */
  async appendTurns(params: {
    conversationId: string;
    userMessage: MessageCreateFields;
    assistantMessage: MessageCreateFields;
    title?: string;
  }) {
    return prisma.$transaction([
      prisma.message.create({ data: params.userMessage }),
      prisma.message.create({ data: params.assistantMessage }),
      prisma.conversation.update({
        where: { id: params.conversationId },
        data: {
          updatedAt: new Date(),
          ...(params.title !== undefined ? { title: params.title } : {}),
        },
      }),
    ]);
  }
}
```

Three details that matter:

- **`findRecentMessages` queries `desc` then reverses in JS.** You want the _newest_ N messages but
  you need them in _oldest-first_ order for the prompt. `orderBy: asc` with `take` would hand you
  the first N messages ever sent — the beginning of the chat, not the recent context. This is a
  genuinely easy bug to ship because it looks fine on a short conversation and only goes wrong once
  a chat passes N turns.
- **`deleteByIdAndUserId` uses `deleteMany`, not `delete`.** `delete` needs a unique `where`, and
  `{ id, userId }` is not a unique index — so `delete` can't express "only if it's theirs" and
  would throw. `deleteMany` accepts the compound filter and returns `{ count: 0 }` when the
  conversation isn't the caller's, which is exactly the signal you want for a 404.
- **`appendTurns` is one transaction.** Both messages land or neither does. Without this you can
  end up with a user turn saved and the assistant turn missing, which corrupts every future
  history load (two user messages in a row confuses the model).

---

## 6. Step 5 — Conversation service (ownership + history budget)

Create `src/services/conversation.service.ts`. This is where per-user and per-chat isolation is
enforced, and where the token budget lives.

```ts
import { MessageRole, Prisma } from "@prisma/client";

import { env } from "@config/env";
import { HTTP_STATUS } from "@constants/http-status";
import { ConversationRepository } from "@repositories/conversation.repository";
import { TokenizerService } from "@services/tokenizer.service";
import type { ChatTurn, RagCitation } from "../types/rag.types";
import { AppError } from "@utils/app-error";

export class ConversationService {
  constructor(
    private readonly conversationRepository: ConversationRepository = new ConversationRepository(),
    private readonly tokenizerService: TokenizerService = new TokenizerService(),
  ) {}

  async create(userId: string, input: { title?: string; documentId?: string }) {
    return this.conversationRepository.create({ userId, ...input });
  }

  async listForUser(userId: string) {
    return this.conversationRepository.findManyByUserId(userId);
  }

  /** Throws 404 if the conversation does not exist OR is not this user's. */
  async requireOwned(conversationId: string, userId: string) {
    const conversation = await this.conversationRepository.findByIdAndUserId(
      conversationId,
      userId,
    );
    if (!conversation) {
      throw new AppError("Conversation not found", HTTP_STATUS.NOT_FOUND);
    }
    return conversation;
  }

  async getWithMessages(conversationId: string, userId: string) {
    const conversation = await this.requireOwned(conversationId, userId);
    const messages = await this.conversationRepository.findAllMessages(conversationId);
    return { conversation, messages };
  }

  async delete(conversationId: string, userId: string): Promise<void> {
    const { count } = await this.conversationRepository.deleteByIdAndUserId(conversationId, userId);
    if (count === 0) {
      throw new AppError("Conversation not found", HTTP_STATUS.NOT_FOUND);
    }
  }

  /**
   * Recent turns, newest-biased, trimmed to the token budget.
   * Assumes the caller has already verified ownership.
   */
  async getHistory(conversationId: string): Promise<ChatTurn[]> {
    if (env.RAG_MAX_HISTORY_MESSAGES === 0) {
      return [];
    }
    const rows = await this.conversationRepository.findRecentMessages(
      conversationId,
      env.RAG_MAX_HISTORY_MESSAGES,
    );

    // Walk backwards from the newest so the turns closest to the question survive.
    const budgeted: ChatTurn[] = [];
    let used = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      const cost = row.tokenCount ?? this.tokenizerService.countTokens(row.content);
      if (used + cost > env.RAG_MAX_HISTORY_TOKENS) {
        break;
      }
      used += cost;
      budgeted.unshift({
        role: row.role === MessageRole.USER ? "user" : "assistant",
        content: row.content,
      });
    }

    // A leading assistant turn reads like the model spoke first; drop it.
    if (budgeted.length > 0 && budgeted[0].role === "assistant") {
      budgeted.shift();
    }
    return budgeted;
  }

  async saveTurn(params: {
    conversationId: string;
    userId: string;
    question: string;
    answer: string;
    citations: RagCitation[];
    isFirstTurn: boolean;
  }): Promise<void> {
    await this.conversationRepository.appendTurns({
      conversationId: params.conversationId,
      userMessage: {
        conversationId: params.conversationId,
        userId: params.userId,
        role: MessageRole.USER,
        content: params.question,
        tokenCount: this.tokenizerService.countTokens(params.question),
      },
      assistantMessage: {
        conversationId: params.conversationId,
        userId: params.userId,
        role: MessageRole.ASSISTANT,
        content: params.answer,
        citations: params.citations as unknown as Prisma.InputJsonValue,
        tokenCount: this.tokenizerService.countTokens(params.answer),
      },
      ...(params.isFirstTurn ? { title: params.question.slice(0, 60) } : {}),
    });
  }
}
```

**The backwards walk in `getHistory` is the part to understand.** When the budget is tight you must
decide which turns to drop. Dropping the _newest_ would be absurd — they're the ones the follow-up
refers to. So you accumulate from the newest backwards and stop when the next turn won't fit, which
keeps the most relevant context and discards ancient history.

`unshift` then restores chronological order, because the model needs to read the conversation
forwards.

The leading-assistant check handles a real edge case: if the budget cut lands between a user
question and its answer, you'd open the history with an assistant message replying to nothing.
Models handle that badly — they tend to imitate the pattern and answer questions you didn't ask.

**Titles** come from the first question, truncated. No LLM call, no latency, and it's what most
chat UIs show. Only set on the first turn so it doesn't churn.

---

## 7. Step 6 — Query condensing

Create `src/services/condense.service.ts`. This is the piece that makes follow-ups actually
retrieve the right chunks.

```ts
import { OllamaService } from "@services/ollama.service";
import type { ChatTurn } from "../types/rag.types";

const CONDENSE_SYSTEM =
  "You rewrite a follow-up question into a standalone question. " +
  "Output ONLY the rewritten question, with no preamble, quotes or explanation.";

function buildCondensePrompt(history: ChatTurn[], question: string): string {
  const transcript = history
    .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`)
    .join("\n");

  return [
    "Given the conversation below, rewrite the final question so it can be understood on its own,",
    "replacing every pronoun and reference with the thing it refers to.",
    "If the question is already standalone, repeat it unchanged.",
    "",
    "Conversation:",
    transcript,
    "",
    `Final question: ${question}`,
    "",
    "Standalone question:",
  ].join("\n");
}

export class CondenseService {
  constructor(private readonly ollamaService: OllamaService = new OllamaService()) {}

  async condense(history: ChatTurn[], question: string): Promise<string> {
    if (history.length === 0) {
      return question;
    }
    try {
      const rewritten = await this.ollamaService.chat([
        { role: "system", content: CONDENSE_SYSTEM },
        { role: "user", content: buildCondensePrompt(history, question) },
      ]);
      const cleaned = rewritten.trim().replace(/^["']|["']$/g, "");
      // A wildly long reply means the model explained itself instead of rewriting.
      if (!cleaned || cleaned.length > question.length + 300) {
        return question;
      }
      return cleaned;
    } catch {
      // Condensing is an optimization, never a reason to fail the whole request.
      return question;
    }
  }
}
```

Four deliberate choices here:

1. **Skip entirely when there is no history.** The first question of a chat is already standalone.
   This saves a full LLM round-trip on the most common request.
2. **Fall back to the original question on any failure.** Worst case you get today's behaviour, not
   a 500. A rewrite is an enhancement to retrieval; it must never be load-bearing.
3. **Guard against a runaway response.** Small models (`llama3.2:1b` is your default) sometimes
   answer the question instead of rewriting it, or add "Sure! Here's the rewritten question:".
   The length check catches the chatty failure mode; stripping wrapping quotes catches the common
   formatting one.
4. **The rewrite is used for retrieval only.** The prompt shown to the model in Step 7 still
   contains the user's _original_ wording, so the answer never feels like it's replying to a
   question they didn't type.

You can watch it work by logging both strings — the difference between
`"And the penalty for that?"` and `"What is the penalty for terminating the Acme contract early?"`
is the entire feature.

---

## 8. Step 7 — Wire memory into `RagService`

Open [src/services/rag.service.ts](src/services/rag.service.ts). The `prepare()` method you
extracted for streaming is exactly the seam you need — both `ask()` and `askStream()` go through it,
so memory added here works in both paths at once.

### 8.1 Extend the input type and constructor

```ts
type AskInput = {
  userId: string;
  question: string;
  documentId?: string;
  topK?: number;
  conversationId?: string;
};

export class RagService {
  constructor(
    private readonly retrievalService: RetrievalService = new RetrievalService(),
    private readonly ollamaService: OllamaService = new OllamaService(),
    private readonly conversationService: ConversationService = new ConversationService(),
    private readonly condenseService: CondenseService = new CondenseService(),
  ) {}
```

Keep the default-argument DI style the rest of the codebase uses.

### 8.2 Rewrite `prepare()`

```ts
private async prepare(input: AskInput): Promise<{
  messages: OllamaChatMessage[];
  citations: RagCitation[];
  history: ChatTurn[];
  isFirstTurn: boolean;
  documentId?: string;
}> {
  let history: ChatTurn[] = [];
  let isFirstTurn = true;
  let documentId = input.documentId;

  if (input.conversationId) {
    // Ownership check FIRST — before any work is done on someone else's conversation.
    const conversation = await this.conversationService.requireOwned(
      input.conversationId,
      input.userId,
    );
    history = await this.conversationService.getHistory(input.conversationId);
    isFirstTurn = history.length === 0;
    documentId = input.documentId ?? conversation.documentId ?? undefined;
  }

  // Retrieval runs on the condensed question; the prompt keeps the original.
  const searchQuery = await this.condenseService.condense(history, input.question);

  const retrieved = await this.retrievalService.retrieveTopK({
    userId: input.userId,
    query: searchQuery,
    topK: input.topK,
    documentId,
  });
  if (retrieved.length === 0) {
    throw new AppError(
      "No indexed content found for this query. Upload and process documents first.",
      HTTP_STATUS.BAD_REQUEST,
    );
  }

  const contextBlocks = retrieved
    .map(
      (chunk, index) =>
        `[chunk_${index + 1}] (${chunk.documentId}/${chunk.id}${formatPageLabel(chunk.pageStart, chunk.pageEnd)}) ${chunk.text}`,
    )
    .join("\n\n");
  const prompt = buildPrompt(input.question, contextBlocks);

  return {
    messages: [
      {
        role: "system",
        content:
          "You must answer only from the provided context. Do not use outside knowledge and do not hallucinate.",
      },
      ...history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: "user", content: prompt },
    ],
    citations: retrieved.map((chunk) => ({
      chunkId: chunk.id,
      documentId: chunk.documentId,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      score: chunk.score,
    })),
    history,
    isFirstTurn,
    documentId,
  };
}
```

**Message ordering is not arbitrary.** It must be `system → history → grounded prompt`. The
retrieved context sits in the _final_ user message, nearest the question, because models weight the
end of the prompt most heavily. Putting history after the context would bury the chunks.

Also note `documentId` resolution order: an explicit request value wins, otherwise the
conversation's pinned document, otherwise search everything.

### 8.3 Update `ask()`

```ts
async ask(input: AskInput): Promise<AskQuestionResponse> {
  const { messages, citations, isFirstTurn } = await this.prepare(input);
  const answer = await this.ollamaService.chat(messages);

  if (input.conversationId) {
    await this.conversationService.saveTurn({
      conversationId: input.conversationId,
      userId: input.userId,
      question: input.question,
      answer,
      citations,
      isFirstTurn,
    });
  }

  return { answer, citations, conversationId: input.conversationId };
}
```

### 8.4 Update `askStream()`

```ts
async askStream(input: AskInput): Promise<RagStreamResult> {
  const { messages, citations, isFirstTurn } = await this.prepare(input);
  const conversationId = input.conversationId;

  return {
    citations,
    conversationId,
    tokens: this.ollamaService.chatStream(messages),
    onComplete: conversationId
      ? async (answer: string) => {
          await this.conversationService.saveTurn({
            conversationId,
            userId: input.userId,
            question: input.question,
            answer,
            citations,
            isFirstTurn,
          });
        }
      : undefined,
  };
}
```

**Why the turn is saved only after the stream finishes:** the assistant's message doesn't exist
until the last token. Saving the user's question up front instead would leave a dangling user turn
whenever generation fails, and the _next_ request would load a history ending in two user messages
in a row — which reliably confuses small models. Writing both together in one transaction (Step 4)
keeps the history well-formed no matter what fails.

The trade-off: if the client disconnects mid-answer, that turn is lost. That is the right default —
a half-answer is worse than no answer in a history that feeds future prompts.

---

## 9. Step 8 — Validators

In [src/validators/rag.validator.ts](src/validators/rag.validator.ts), add `conversationId` to the
existing ask schema (optional, so today's clients keep working):

```ts
export const askQuestionSchema = z.object({
  question: z.string().trim().min(1, "question is required").max(2000, "question is too long"),
  documentId: z.string().uuid("documentId must be a valid UUID").optional(),
  conversationId: z.string().uuid("conversationId must be a valid UUID").optional(),
  topK: z.coerce
    .number()
    .int()
    .min(1, "topK must be at least 1")
    .max(12, "topK must be <= 12")
    .optional(),
});
```

Then create `src/validators/conversation.validator.ts`:

```ts
import { z } from "zod";

export const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  documentId: z.string().uuid("documentId must be a valid UUID").optional(),
});

export const conversationIdParamsSchema = z.object({
  id: z.string().uuid("id must be a valid UUID"),
});
```

The `.uuid()` check earns its keep: it rejects a malformed id at the middleware with a clean 400
before it ever reaches Prisma, which would otherwise throw a less readable error.

---

## 10. Step 9 — Controller and routes

### 10.1 `src/controllers/conversation.controller.ts`

```ts
import type { Request, Response } from "express";

import { HTTP_STATUS } from "@constants/http-status";
import { ConversationService } from "@services/conversation.service";
import { AppError } from "@utils/app-error";
import { sendSuccess } from "@utils/api-response";
import { asyncHandler } from "@utils/async-handler";

const conversationService = new ConversationService();

export const createConversation = asyncHandler(
  async (
    req: Request<unknown, unknown, { title?: string; documentId?: string }>,
    res: Response,
  ): Promise<void> => {
    if (!req.user) {
      throw new AppError("Unauthorized", HTTP_STATUS.UNAUTHORIZED);
    }
    const conversation = await conversationService.create(req.user.id, {
      title: req.body.title,
      documentId: req.body.documentId,
    });
    sendSuccess(res, HTTP_STATUS.CREATED, conversation);
  },
);

export const listConversations = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new AppError("Unauthorized", HTTP_STATUS.UNAUTHORIZED);
    }
    const conversations = await conversationService.listForUser(req.user.id);
    sendSuccess(res, HTTP_STATUS.OK, conversations);
  },
);

export const getConversation = asyncHandler(
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    if (!req.user) {
      throw new AppError("Unauthorized", HTTP_STATUS.UNAUTHORIZED);
    }
    const data = await conversationService.getWithMessages(req.params.id, req.user.id);
    sendSuccess(res, HTTP_STATUS.OK, data);
  },
);

export const deleteConversation = asyncHandler(
  async (req: Request<{ id: string }>, res: Response): Promise<void> => {
    if (!req.user) {
      throw new AppError("Unauthorized", HTTP_STATUS.UNAUTHORIZED);
    }
    await conversationService.delete(req.params.id, req.user.id);
    sendSuccess(res, HTTP_STATUS.OK, { id: req.params.id }, "Conversation deleted");
  },
);
```

Every handler reads the owner from `req.user.id` and passes it down — never from the body or query.
That single habit is what makes the feature safe.

### 10.2 `src/routes/conversation.route.ts`

```ts
import { Router } from "express";

import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
} from "@controllers/conversation.controller";
import { requireAuth } from "@middlewares/auth.middleware";
import { validateRequest } from "@middlewares/validate-request";
import {
  conversationIdParamsSchema,
  createConversationSchema,
} from "@validators/conversation.validator";

const conversationRouter = Router();

conversationRouter.post(
  "/",
  requireAuth,
  validateRequest({ body: createConversationSchema }),
  createConversation,
);
conversationRouter.get("/", requireAuth, listConversations);
conversationRouter.get(
  "/:id",
  requireAuth,
  validateRequest({ params: conversationIdParamsSchema }),
  getConversation,
);
conversationRouter.delete(
  "/:id",
  requireAuth,
  validateRequest({ params: conversationIdParamsSchema }),
  deleteConversation,
);

export { conversationRouter };
```

### 10.3 Mount it in [src/routes/index.ts](src/routes/index.ts)

```ts
router.use("/conversations", conversationRouter);
```

Put it **above** `router.use("/", ragRouter)`. The RAG router is mounted at the root, so anything
registered after it competes with its paths — keep specific prefixes first.

### 10.4 Pass `conversationId` through the ask controllers

In [src/controllers/rag.controller.ts](src/controllers/rag.controller.ts), widen both request body
types and forward the new field.

For `askQuestion`:

```ts
req: Request<
  unknown,
  unknown,
  { question: string; documentId?: string; topK?: number; conversationId?: string }
>,
...
const data = await ragService.ask({
  userId: req.user.id,
  question: req.body.question,
  documentId: req.body.documentId,
  topK: req.body.topK,
  conversationId: req.body.conversationId,
});
```

For `askQuestionStream`, the same widening plus accumulating the answer so `onComplete` can save it:

```ts
const { citations, tokens, conversationId, onComplete } = await ragService.askStream({
  userId: req.user.id,
  question: req.body.question,
  documentId: req.body.documentId,
  topK: req.body.topK,
  conversationId: req.body.conversationId,
});

initSse(res);
try {
  let answer = "";
  for await (const text of tokens) {
    answer += text;
    sendSseEvent(res, "token", { text });
  }
  if (onComplete) {
    await onComplete(answer);
  }
  sendSseEvent(res, "citations", { citations });
  sendSseEvent(res, "done", { conversationId });
} catch (error) {
  logger.error({ err: error, path: req.originalUrl }, "Ask stream failed");
  sendSseEvent(res, "error", {
    status: error instanceof AppError ? error.statusCode : HTTP_STATUS.INTERNAL_SERVER_ERROR,
    message: error instanceof AppError ? error.message : "Streaming failed",
  });
} finally {
  res.end();
}
```

Note `onComplete` is awaited **inside** the `try`. If the database write fails, the client gets an
`error` frame rather than a `done` frame it would wrongly trust — and the existing catch already
keeps that from becoming an `ERR_HTTP_HEADERS_SENT` crash.

The `done` event now carries `conversationId`, which is how a client that started a fresh chat
learns the id to use for the next turn.

---

## 11. Verification

There is no test runner in this repo, so the gate is:

```bash
pnpm run lint && pnpm run typecheck && pnpm run build
```

Then check the behaviour by hand. Start the stack (`docker compose up`), make sure at least one
document is `READY`, and log in to get a token.

**1. Create a chat and ask two related questions:**

```bash
CONV=$(curl -s -X POST localhost:4000/api/v1/conversations \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{}' | jq -r '.data.id')

curl -s -X POST localhost:4000/api/v1/ask \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"conversationId\":\"$CONV\",\"question\":\"What does the contract say about termination?\"}" \
  | jq -r '.data.answer'

# The follow-up — this is the whole feature
curl -s -X POST localhost:4000/api/v1/ask \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"conversationId\":\"$CONV\",\"question\":\"And the penalty for that?\"}" \
  | jq -r '.data.answer'
```

The second answer must be about termination penalties. If it says "I could not find this in your
uploaded documents", condensing is not working — log the output of `condense()` and check whether
the rewrite actually replaced the pronoun.

**2. History persisted correctly:**

```bash
curl -s localhost:4000/api/v1/conversations/$CONV \
  -H "Authorization: Bearer $TOKEN" | jq '.data.messages | map({role, content: .content[0:60]})'
```

Expect four messages alternating `USER, ASSISTANT, USER, ASSISTANT`. Two `USER` rows in a row means
a save failed halfway — check that `appendTurns` really is a single `$transaction`.

**3. Per-user isolation (the security check — do not skip):**

Log in as a _second_ user and request the first user's conversation id:

```bash
curl -s -i localhost:4000/api/v1/conversations/$CONV -H "Authorization: Bearer $OTHER_TOKEN"
curl -s -i -X DELETE localhost:4000/api/v1/conversations/$CONV -H "Authorization: Bearer $OTHER_TOKEN"
curl -s -i -X POST localhost:4000/api/v1/ask -H "Authorization: Bearer $OTHER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"conversationId\":\"$CONV\",\"question\":\"what did they ask?\"}"
```

All three must return **404**, and the conversation must still exist afterwards. A 200 on any of
them means an ownership filter is missing.

**4. Backward compatibility:** ask without `conversationId` — it must work exactly as before and
write nothing to the `Message` table.

**5. Streaming:** hit `/ask/stream` with a `conversationId`, confirm the `done` frame carries it,
then re-fetch the conversation and confirm the streamed answer was saved in full.

---

## 12. Things that will bite you

- **`num_ctx` is the silent killer.** If answers get vaguer and stop citing pages once conversations
  get long, you are overflowing the context window. Nothing errors. Raise `OLLAMA_NUM_CTX` or lower
  `RAG_MAX_HISTORY_TOKENS`. Check by summing: history tokens + (`topK` × ~250) + ~200 must stay
  comfortably under `num_ctx`.
- **Condensing doubles your LLM calls.** Every follow-up is now two round-trips. On
  `llama3.2:1b` that's cheap; on a larger chat model it is noticeable, and it lands _before_ the
  first streamed token, so it shows up as slower time-to-first-token. If that hurts, run a small
  fast model for condensing specifically.
- **Two asks on one conversation at the same time** will interleave their saves and can produce a
  scrambled history. A per-conversation lock or a "generation in progress" flag fixes it; not worth
  building until the UI allows it.
- **Messages grow forever.** Nothing prunes them. The budget caps what's _sent_ to the model, not
  what's _stored_. Add retention later if it matters.
- **Rate limiting counts conversations, not tokens.** The global limiter in
  [src/app.ts](src/app.ts) is per-IP. A long chat is many requests; ROADMAP already tracks per-user
  limits on `/ask`.

---

## 13. Build order checklist

Run `pnpm run typecheck` after each step.

- [ ] Step 1 — schema + `pnpm run prisma:migrate`
- [ ] Step 2 — env vars in all three files + `num_ctx` in **both** client methods
- [ ] Step 3 — types in `rag.types.ts`
- [ ] Step 4 — `conversation.repository.ts`
- [ ] Step 5 — `conversation.service.ts`
- [ ] Step 6 — `condense.service.ts`
- [ ] Step 7 — `RagService.prepare` / `ask` / `askStream`
- [ ] Step 8 — validators
- [ ] Step 9 — controller, route, mount, `conversationId` through both ask handlers
- [ ] Verification steps 1–5, especially the per-user isolation check
- [ ] Tick ROADMAP item 4
