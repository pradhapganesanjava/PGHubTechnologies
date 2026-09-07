#!/usr/bin/env bash
# Install the pre-push safety check into this checkout's .git/hooks.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
install -m 755 "$root/tools/hooks/pre-push" "$root/.git/hooks/pre-push"
echo "  installed .git/hooks/pre-push -> tools/check-public-safe.sh"
