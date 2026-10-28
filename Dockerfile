FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
# su-exec: lets the entrypoint fix the data folder's owner, then run as a normal user.
RUN apk add --no-cache su-exec
# No dependencies to install: the server uses only Node's standard library.
COPY package.json ./
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data
# State (accounts, orders, designs, client logs) lives here; mount a volume on it.
ENV DESIGNWEAR_DATA_FILE=/data/store.json \
    DESIGNWEAR_CLIENT_LOG_FILE=/data/client-logs.ndjson \
    PORT=8787
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/v1/health || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
