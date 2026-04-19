# IntelliDocs

IntelliDocs is a retrieval-augmented generation (RAG) backend. Clients upload **PDF** and **TXT** documents; the service prepares them for search, and clients can ask **any question** about the material in those files and receive answers informed by the ingested content.

## What it does

- Accepts document uploads (PDF and plain text) from clients.
- Stores and indexes document content for semantic retrieval.
- Exposes an API for questions so responses stay tied to the supplied documents rather than generic model knowledge alone.

## Tech stack

- Node.js (LTS)
- Express.js
- TypeScript (strict mode)
- PostgreSQL
- Prisma ORM
- Zod
- Pino
- ESLint + Prettier + Husky + lint-staged

## Project structure

```text
src/
├── config/
├── controllers/
├── services/
├── repositories/
├── routes/
├── middlewares/
├── validators/
├── utils/
├── types/
├── constants/
├── app.ts
└── server.ts
prisma/
.env
.env.example
```

## Quick start

1. Install dependencies:

```bash
pnpm install
```

2. Configure environment:

```bash
cp .env.example .env
```

3. Start PostgreSQL (local or Docker), then run migrations:

```bash
pnpm run prisma:migrate
```

4. Generate Prisma client:

```bash
pnpm run prisma:generate
```

5. Seed database:

```bash
pnpm run seed
```

6. Run development server:

```bash
pnpm run dev
```

## Scripts

- `pnpm run dev` - start dev server with auto-reload
- `pnpm run build` - compile production build
- `pnpm run start` - run compiled app
- `pnpm run lint` - run ESLint
- `pnpm run lint:fix` - fix lint issues
- `pnpm run format` - format code with Prettier
- `pnpm run prisma:generate` - generate Prisma client
- `pnpm run prisma:migrate` - run Prisma migrations
- `pnpm run prisma:studio` - open Prisma Studio
- `pnpm run seed` - seed database

## HTTP API

- `GET /health` — service health
- `POST /users` — create user
- `GET /users` — list users
- `GET /users/:id` — get user by id
- `PATCH /users/:id` — update user
- `DELETE /users/:id` — delete user

## Docker

Use Docker Compose for local API + PostgreSQL:

```bash
docker compose up --build
```

## Notes

- Husky is configured, but Git hooks are installed only after `git init` is available in this folder.
