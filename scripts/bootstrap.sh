#!/usr/bin/env bash
set -euo pipefail
corepack enable
pnpm install
cp -n .env.example .env || true
pnpm verify
