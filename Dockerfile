# syntax=docker/dockerfile:1.7

# ---- deps: full install (dev deps included) for building and for running migrations ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- build: generate Prisma client and compile TypeScript ----
FROM deps AS build
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npx prisma generate && npm run build

# ---- migrate: one-off image used by compose and by the ECS migration task ----
FROM build AS migrate
CMD ["npx", "prisma", "migrate", "deploy"]

# ---- runtime: production dependencies only ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
USER app
EXPOSE 3000 3001
CMD ["node", "dist/main"]
