#!/bin/sh
set -e

# Fix permissions on bind-mounted volumes that Docker creates as root.
# The Dockerfile sets correct ownership in the image layer (chown app:app /data),
# but when ./data doesn't exist on the host, Docker daemon creates it as root
# and the bind mount obscures the image's permission setup. This runs as root
# before dropping privileges, so the fix always applies.
chown -R app:app /data 2>/dev/null || true

# Preserve the node-wrapping logic from the node base image: if the first arg
# starts with "-" or isn't a known command, prepend "node".
if [ "${1#-}" != "${1}" ] || [ -z "$(command -v "${1}")" ] || { [ -f "${1}" ] && ! [ -x "${1}" ]; }; then
  set -- node "$@"
fi

# Drop to the unprivileged app user and run the command.
exec su-exec app:app "$@"
