# Production-Ready Node.js Backend 

Express + TypeScript + PostgreSQL + Prisma backend template with layered architecture and production-grade tooling.

## Tech Stack

- Node.js (LTS)
- Express.js
- TypeScript (strict mode)
- PostgreSQL
- Prisma ORM
- Zod
- Pino
- ESLint + Prettier + Husky + lint-staged

## Project Structure

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

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env
```

3. Start PostgreSQL (local or Docker), then run migrations:

```bash
npm run prisma:migrate
```

4. Generate Prisma client:

```bash
npm run prisma:generate
```

5. Seed database:

```bash
npm run seed
```

6. Run development server:

```bash
npm run dev
```

## Scripts

- `npm run dev` - start dev server with auto-reload
- `npm run build` - compile production build
- `npm run start` - run compiled app
- `npm run lint` - run ESLint
- `npm run lint:fix` - fix lint issues
- `npm run format` - format code with Prettier
- `npm run prisma:generate` - generate Prisma client
- `npm run prisma:migrate` - run Prisma migrations
- `npm run prisma:studio` - open Prisma Studio
- `npm run seed` - seed database

## Implemented Endpoints

- `GET /health`
- `POST /users`
- `GET /users`
- `GET /users/:id`
- `PATCH /users/:id`
- `DELETE /users/:id`

## Docker

Use Docker Compose for local API + PostgreSQL:

```bash
docker compose up --build
```

## Notes

- Husky is configured, but Git hooks are installed only after `git init` is available in this folder.
