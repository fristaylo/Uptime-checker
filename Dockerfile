FROM oven/bun:1-alpine AS builder
WORKDIR /app

COPY package.json bun.lock* bun.lockb* package-lock.json* ./

RUN bun install --frozen-lockfile || bun install

COPY client/ ./client
COPY server/ ./server

RUN bun run build

FROM oven/bun:1-alpine
RUN apk add --no-cache nginx
WORKDIR /app

COPY --from=builder /app/server ./server
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/client/src/data ./client/src/data
COPY --from=builder /app/node_modules ./node_modules
COPY bot/ ./bot
COPY package.json .

COPY docker/nginx/nginx.conf /etc/nginx/nginx.conf

CMD sh -c "nginx -g 'daemon off;' & bun server/index.js"
