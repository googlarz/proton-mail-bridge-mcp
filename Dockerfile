FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
RUN npm install -g mcp-proxy

COPY dist ./dist
COPY README.md CLAUDE-DESKTOP-PACKAGING.md FINAL-VALIDATION.md LICENSE ./
COPY docker/start-inspectable.sh /usr/local/bin/start-inspectable.sh

RUN chmod +x /usr/local/bin/start-inspectable.sh

EXPOSE 8080

CMD ["start-inspectable.sh"]
