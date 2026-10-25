# Image produksi untuk dashboard SaViOr konveksi (Next.js).
# Build context: ../GitHub/savior-app (lihat compose.yaml).
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund --fetch-retries=5 --fetch-timeout=120000

FROM deps AS build
COPY . .
# lib/db.js mewajibkan DATABASE_URL saat modul dimuat; nilai ini hanya untuk build,
# koneksi sesungguhnya diberikan saat runtime.
ENV NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=postgres://build:build@127.0.0.1:5432/build \
    AUTH_SECRET=build-only-not-used-at-runtime
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund --fetch-retries=5 --fetch-timeout=120000
COPY --from=build --chown=node:node /app/.next ./.next
# --chown karena sebagian file repo ber-mode 600 (mis. package.json, scripts/).
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/database ./database
USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "start"]
