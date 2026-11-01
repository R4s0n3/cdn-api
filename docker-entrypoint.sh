#!/bin/sh
set -eu

ROOT="${SERVER_ROOT:-/data}"
mkdir -p "${ROOT}/assets"

exec "$@"
