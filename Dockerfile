FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data/sessions \
  && chown -R node:node /data
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile
COPY src/server.ts ./src/server.ts
COPY src/watchalong.ts ./src/watchalong.ts
COPY src/casting.ts ./src/casting.ts
COPY src/session-store.ts ./src/session-store.ts
COPY src/media-rules.ts ./src/media-rules.ts
COPY --from=build /app/dist/public ./dist/public
ENV NODE_ENV=production PORT=3000 SESSION_DATA_ROOT=/data/sessions
EXPOSE 3000
USER node
CMD ["pnpm", "start"]
