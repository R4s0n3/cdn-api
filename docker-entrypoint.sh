#!/bin/sh
set -eu

cd /app

ROOT="${SERVER_ROOT:-/data}"
mkdir -p "${ROOT}/assets" "${ROOT}/storage"

./node_modules/.bin/prisma migrate deploy

exec "$@"
