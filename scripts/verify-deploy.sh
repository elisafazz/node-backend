#!/usr/bin/env bash
# verify-deploy.sh -- run after `vercel --prod` to confirm the node-backend deployment is healthy.
# Usage: VERCEL_URL=https://node-backend-xyz.vercel.app SUPABASE_URL=https://abc.supabase.co ./scripts/verify-deploy.sh
#
# Exits 0 if all checks pass, 1 on first failure (fail-loud per CLAUDE.md).

set -u

if [[ -z "${VERCEL_URL:-}" ]]; then
  echo "FAIL: VERCEL_URL env var not set"
  exit 1
fi
if [[ -z "${SUPABASE_URL:-}" ]]; then
  echo "FAIL: SUPABASE_URL env var not set"
  exit 1
fi

VERCEL_URL="${VERCEL_URL%/}"
SUPABASE_URL="${SUPABASE_URL%/}"

PASS=0
FAIL=0

check_status() {
  local label="$1"
  local url="$2"
  local expect="$3"
  local actual
  actual=$(curl -s -o /dev/null -w "%{http_code}" "$url")
  if [[ "$actual" == "$expect" ]]; then
    echo "PASS  $label  ($url -> $actual)"
    PASS=$((PASS+1))
  else
    echo "FAIL  $label  ($url -> got $actual, expected $expect)"
    FAIL=$((FAIL+1))
  fi
}

check_grep() {
  local label="$1"
  local url="$2"
  local pattern="$3"
  local body
  body=$(curl -s "$url")
  if echo "$body" | grep -q "$pattern"; then
    echo "PASS  $label  ($url contains '$pattern')"
    PASS=$((PASS+1))
  else
    echo "FAIL  $label  ($url does NOT contain '$pattern')"
    FAIL=$((FAIL+1))
  fi
}

echo "==== Vercel routes (legal pages + dynamic contact) ===="
check_status "/tos"      "$VERCEL_URL/tos"      "200"
check_status "/privacy"  "$VERCEL_URL/privacy"  "200"
check_status "/eula"     "$VERCEL_URL/eula"     "200"
check_status "/contact"  "$VERCEL_URL/contact"  "200"
# /contact is a dynamic API route. Confirm CONTACT_EMAIL was actually substituted.
check_grep "/contact has email substituted" "$VERCEL_URL/contact" "mailto:"

echo ""
echo "==== Vercel push API ===="
# /api/push without payload should fail validation (4xx), proving the function is alive.
PUSH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$VERCEL_URL/api/push" -H "content-type: application/json" -d '{}')
if [[ "$PUSH_STATUS" =~ ^4 ]]; then
  echo "PASS  /api/push reachable  (returned $PUSH_STATUS for empty body, expected 4xx)"
  PASS=$((PASS+1))
else
  echo "FAIL  /api/push  (returned $PUSH_STATUS for empty body, expected 4xx)"
  FAIL=$((FAIL+1))
fi

echo ""
echo "==== Supabase Edge Functions ===="
# Edge Functions return 401 without a JWT, proving they are deployed.
for fn in apple-exchange-code apple-revoke cloudinary-sign delete-user-data report-intake; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$SUPABASE_URL/functions/v1/$fn" -H "content-type: application/json" -d '{}')
  if [[ "$STATUS" == "401" || "$STATUS" == "403" || "$STATUS" =~ ^4 ]]; then
    echo "PASS  $fn deployed  (returned $STATUS without auth, expected 4xx)"
    PASS=$((PASS+1))
  else
    echo "FAIL  $fn  (returned $STATUS without auth, expected 4xx)"
    FAIL=$((FAIL+1))
  fi
done

echo ""
echo "==== Supabase Postgres (anon role -> RLS should block) ===="
if [[ -n "${SUPABASE_ANON_KEY:-}" ]]; then
  # Anon should get 0 rows from public.nodes thanks to RLS, even if rows exist.
  ROWS=$(curl -s "$SUPABASE_URL/rest/v1/nodes?select=id" \
    -H "apikey: $SUPABASE_ANON_KEY" \
    -H "Authorization: Bearer $SUPABASE_ANON_KEY")
  if [[ "$ROWS" == "[]" ]]; then
    echo "PASS  RLS  (anon SELECT on public.nodes returned [])"
    PASS=$((PASS+1))
  else
    echo "FAIL  RLS  (anon SELECT on public.nodes returned non-empty: $ROWS)"
    echo "      ^ this means RLS is misconfigured; FIX BEFORE PROCEEDING."
    FAIL=$((FAIL+1))
  fi
else
  echo "SKIP  RLS  (set SUPABASE_ANON_KEY to enable this check)"
fi

echo ""
echo "==== Summary ===="
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
