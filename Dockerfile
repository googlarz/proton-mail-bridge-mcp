FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts

COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm install -g mcp-proxy

COPY --from=builder /app/dist ./dist
COPY README.md LICENSE ./
COPY docker/start-inspectable.sh /usr/local/bin/start-inspectable.sh

RUN chmod +x /usr/local/bin/start-inspectable.sh

EXPOSE 8080

CMD ["start-inspectable.sh"]
