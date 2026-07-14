#!/usr/bin/env bash
set -euo pipefail
pnpm typecheck
pnpm test
