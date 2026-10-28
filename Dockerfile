FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
# No dependencies to install: the server uses only Node's standard library.
COPY package.json ./
COPY src ./src
# State (accounts, orders, designs, client logs) lives here; mount a volume on it.
RUN mkdir -p /data && chown node:node /data
ENV DESIGNWEAR_DATA_FILE=/data/store.json \
    DESIGNWEAR_CLIENT_LOG_FILE=/data/client-logs.ndjson \
    PORT=8787
USER node
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/v1/health || exit 1
CMD ["node", "src/index.js"]
