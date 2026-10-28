#!/usr/bin/env bash
# Copies the filled-in lines of .env.production to the Vercel project's Production
# environment, then redeploys the latest production deployment so they take effect.
# Values are sent on stdin and never printed.
#   scripts/push-env-to-vercel.sh             push and redeploy
#   scripts/push-env-to-vercel.sh --dry-run   only list the names that would be pushed
set -euo pipefail
cd "$(dirname "$0")/.."
file=".env.production"
dry=false; [ "${1:-}" = "--dry-run" ] && dry=true
[ -f "$file" ] || { echo "$file not found"; exit 1; }

names=()
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  name="${line%%=*}"; value="${line#*=}"
  [ -n "$value" ] || continue
  names+=("$name")
  if ! $dry; then
    printf '%s' "$value" | npx --yes vercel env add "$name" production --force >/dev/null 2>&1 \
      && echo "set      $name" || echo "FAILED   $name"
  fi
done < "$file"

if [ "${#names[@]}" -eq 0 ]; then echo "Nothing filled in yet."; exit 0; fi
$dry && { echo "Would push: ${names[*]}"; exit 0; }

echo "Redeploying the latest production deployment..."
latest=$(npx --yes vercel ls --prod 2>/dev/null | grep -Eo 'https://[a-z0-9.-]+\.vercel\.app' | head -1)
[ -n "$latest" ] && npx --yes vercel redeploy "$latest" || echo "Redeploy it from the Vercel dashboard (Deployments, Redeploy)."
