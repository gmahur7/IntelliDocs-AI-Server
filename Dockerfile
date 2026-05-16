FROM node:22-alpine AS base

RUN corepack enable pnpm

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
COPY prisma/schema.prisma prisma/schema.prisma
RUN pnpm install --frozen-lockfile

COPY . .
ARG DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres?schema=public"
ENV DATABASE_URL=$DATABASE_URL
RUN pnpm run prisma:generate
RUN pnpm run build

EXPOSE 4000
CMD ["pnpm", "run", "start"]
