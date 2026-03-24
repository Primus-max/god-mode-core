#!/usr/bin/env bash
set -euo pipefail
# Delegate to Node for parity with Windows (see bundle-a2ui.mjs).
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$ROOT_DIR/scripts/bundle-a2ui.mjs"
