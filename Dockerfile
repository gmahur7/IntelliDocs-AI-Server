FROM node:22-alpine AS base

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
ARG DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres?schema=public"
ENV DATABASE_URL=$DATABASE_URL
RUN npm run prisma:generate
RUN npm run build

EXPOSE 4000
CMD ["npm", "run", "start"]
