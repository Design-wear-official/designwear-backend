#!/bin/sh
# Hosting platforms mount the data volume owned by root. Make it writable for the
# unprivileged "node" user, then drop root before starting the server.
set -e
chown -R node:node /data
exec su-exec node "$@"
