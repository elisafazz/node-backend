#!/usr/bin/env node
// Smoke-test: send invalid requests to every endpoint and confirm each returns the expected 4xx.
// Proves the routing is wired and the functions are deployed; does NOT require live APNs / Apple / Cloudinary credentials.
//
// Usage:
//   VERCEL_URL=https://node-app-backend.vercel.app SUPABASE_URL=https://abc.supabase.co node scripts/smoke-test.mjs

const VERCEL_URL = (process.env.VERCEL_URL ?? "").replace(/\/$/, "");
const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");

if (!VERCEL_URL || !SUPABASE_URL) {
  console.error("FAIL: VERCEL_URL and SUPABASE_URL env vars required");
  process.exit(1);
}

let pass = 0;
let fail = 0;

async function expect4xx(label, url, init = {}) {
  let status;
  try {
    const res = await fetch(url, init);
    status = res.status;
  } catch (err) {
    console.log(`FAIL  ${label}  (network error: ${err.message})`);
    fail++;
    return;
  }
  if (status >= 400 && status < 500) {
    console.log(`PASS  ${label}  (${status})`);
    pass++;
  } else {
    console.log(`FAIL  ${label}  (got ${status}, expected 4xx)`);
    fail++;
  }
}

async function expect200(label, url) {
  try {
    const res = await fetch(url);
    if (res.status === 200) {
      console.log(`PASS  ${label}  (200)`);
      pass++;
    } else {
      console.log(`FAIL  ${label}  (got ${res.status}, expected 200)`);
      fail++;
    }
  } catch (err) {
    console.log(`FAIL  ${label}  (network error: ${err.message})`);
    fail++;
  }
}

console.log("==== Vercel routes ====");
await expect200("/tos", `${VERCEL_URL}/tos`);
await expect200("/privacy", `${VERCEL_URL}/privacy`);
await expect200("/eula", `${VERCEL_URL}/eula`);
await expect200("/contact", `${VERCEL_URL}/contact`);

console.log("");
console.log("==== Vercel /api/push (no auth header -> 401) ====");
await expect4xx("/api/push without secret", `${VERCEL_URL}/api/push`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({}),
});

console.log("");
console.log("==== Supabase Edge Functions (no JWT -> 401) ====");
for (const fn of [
  "apple-exchange-code",
  "apple-revoke",
  "cloudinary-sign",
  "delete-user-data",
  "report-intake",
]) {
  await expect4xx(`function ${fn}`, `${SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}

console.log("");
console.log("==== Summary ====");
console.log(`Passed: ${pass}`);
console.log(`Failed: ${fail}`);

process.exit(fail > 0 ? 1 : 0);
