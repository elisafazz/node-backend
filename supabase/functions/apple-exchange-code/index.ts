// Edge Function: apple-exchange-code
// Called by iOS once on first Sign in with Apple.
// Exchanges the Apple authorization code for a refresh_token and stores it in private.apple_oauth_credentials.
// This is required for Apple-compliant account deletion (ADR-004): Supabase Auth does NOT
// expose the providerRefreshToken, so we capture it ourselves via Apple's /auth/token endpoint.
//
// Request body: { "code": "...apple-auth-code..." }
// Auth: Supabase JWT (verify_jwt = true in config.toml)

// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { create as jwtCreate, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";

interface ExchangeRequest {
  code: string;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "missing_auth" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  let body: ExchangeRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_body" }), { status: 400 });
  }
  if (!body.code || typeof body.code !== "string") {
    return new Response(JSON.stringify({ error: "missing_code" }), { status: 400 });
  }

  // Identify the caller
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

  const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ error: "auth_failed" }), { status: 401 });
  }
  const userId = userData.user.id;

  // Build Apple client_secret JWT
  const APPLE_TEAM_ID = Deno.env.get("APPLE_TEAM_ID")!;
  const APPLE_SERVICE_ID = Deno.env.get("APPLE_SERVICE_ID")!;
  const APPLE_KEY_ID = Deno.env.get("APPLE_KEY_ID")!;
  const APPLE_PRIVATE_KEY = Deno.env.get("APPLE_PRIVATE_KEY")!; // .p8 contents

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
        exp: getNumericDate(60 * 60 * 24 * 30 * 6), // 6 months max per Apple
        aud: "https://appleid.apple.com",
        sub: APPLE_SERVICE_ID,
      },
      key,
    );
  } catch (e) {
    console.error("client_secret_build_failed", e);
    return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
  }

  // Exchange the code with Apple
  const params = new URLSearchParams({
    client_id: APPLE_SERVICE_ID,
    client_secret: clientSecret,
    code: body.code,
    grant_type: "authorization_code",
  });

  const appleRes = await fetch(APPLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!appleRes.ok) {
    const text = await appleRes.text();
    console.error("apple_token_exchange_failed", appleRes.status, text);
    return new Response(JSON.stringify({ error: "apple_exchange_failed", apple_status: appleRes.status }), { status: 502 });
  }

  const appleData = await appleRes.json() as { refresh_token?: string };
  if (!appleData.refresh_token) {
    return new Response(JSON.stringify({ error: "apple_no_refresh_token" }), { status: 502 });
  }

  // Upsert the refresh token. Service role can write to private schema.
  const { error: upsertErr } = await supabase
    .schema("private" as any)
    .from("apple_oauth_credentials")
    .upsert({
      user_id: userId,
      refresh_token: appleData.refresh_token,
      last_refreshed_at: new Date().toISOString(),
    });

  if (upsertErr) {
    console.error("upsert_failed", upsertErr);
    return new Response(JSON.stringify({ error: "storage_failed" }), { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
