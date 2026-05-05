// Edge Function: apple-revoke
// Internal-only. Called by delete-user-data with the user's stored Apple refresh_token.
// Revokes the user's Apple authorization grant via Apple's /auth/revoke endpoint.
// Required for App Store Guideline 5.1.1(v) compliance.
//
// Request body: { "refresh_token": "..." }
// Auth: PUSH_FANOUT_SECRET shared secret in X-Internal-Secret header
//   (verify_jwt = false; this function is service-to-service from delete-user-data)

import { create as jwtCreate, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const internalSecret = req.headers.get("X-Internal-Secret");
  if (internalSecret !== Deno.env.get("PUSH_FANOUT_SECRET")) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  let body: { refresh_token?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_body" }), { status: 400 });
  }
  if (!body.refresh_token) {
    return new Response(JSON.stringify({ error: "missing_refresh_token" }), { status: 400 });
  }

  const APPLE_TEAM_ID = Deno.env.get("APPLE_TEAM_ID")!;
  const APPLE_SERVICE_ID = Deno.env.get("APPLE_SERVICE_ID")!;
  const APPLE_KEY_ID = Deno.env.get("APPLE_KEY_ID")!;
  const APPLE_PRIVATE_KEY = Deno.env.get("APPLE_PRIVATE_KEY")!;

  let clientSecret: string;
  try {
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pemToArrayBuffer(APPLE_PRIVATE_KEY),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    clientSecret = await jwtCreate(
      { alg: "ES256", typ: "JWT", kid: APPLE_KEY_ID },
      {
        iss: APPLE_TEAM_ID,
        iat: getNumericDate(0),
        exp: getNumericDate(60 * 60 * 24 * 30 * 6),
        aud: "https://appleid.apple.com",
        sub: APPLE_SERVICE_ID,
      },
      key,
    );
  } catch (e) {
    console.error("client_secret_build_failed", e);
    return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
  }

  const params = new URLSearchParams({
    client_id: APPLE_SERVICE_ID,
    client_secret: clientSecret,
    token: body.refresh_token,
    token_type_hint: "refresh_token",
  });

  const appleRes = await fetch(APPLE_REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  // Apple returns 200 on success with empty body
  if (!appleRes.ok) {
    const text = await appleRes.text();
    console.error("apple_revoke_failed", appleRes.status, text);
    return new Response(JSON.stringify({ error: "apple_revoke_failed", apple_status: appleRes.status }), { status: 502 });
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
});

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN [A-Z ]+-----/g, "").replace(/-----END [A-Z ]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
