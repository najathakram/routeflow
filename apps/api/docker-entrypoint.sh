#!/bin/sh
# F12-003: run the app as the non-root `node` user. The Railway uploads volume is
# mounted at /data owned by root, so we (as root) ensure it's writable by `node`
# BEFORE dropping privileges — otherwise storage writes (product images, PDFs) fail.
# Everything after this runs as uid 1000, shrinking the blast radius of any RCE.
set -e

mkdir -p /data/uploads
# Best-effort: a fresh volume needs the ownership fixed once; a large existing
# volume just re-affirms it. Never fail boot if the FS refuses (e.g. read-only mount).
chown -R node:node /data 2>/dev/null || true

exec su-exec node "$@"
