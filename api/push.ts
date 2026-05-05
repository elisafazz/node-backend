// Vercel API: /api/push
// APNs fan-out for Node app.
// Called by iOS (or by a Supabase Edge Function trigger) when a new story is posted.
// Reads device tokens for all members of a node EXCEPT the author, sends APNs notification to each.
// Cleans up dead tokens (Apple-reported BadDeviceToken / Unregistered) so we do not retry them.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import jwt from "jsonwebtoken";

interface PushBody {
  node_id: string;
  author_user_id: string;
  title: string;
  body: string;
  category?: string;
}

interface MembershipRow {
  user_id: string;
  device_token: string | null;
}

const APNS_HOST = process.env.APNS_PRODUCTION === "true"
  ? "https://api.push.apple.com"
  : "https://api.sandbox.push.apple.com";

const APNS_REQUEST_TIMEOUT_MS = 5_000;

// Reasons Apple returns when a token is permanently invalid. Source: APNs docs.
const DEAD_TOKEN_REASONS = new Set([
  "BadDeviceToken",
  "Unregistered",
  "DeviceTokenNotForTopic",
]);

function maskToken(token: string): string {
  return token.length <= 8 ? "***" : `${token.slice(0, 4)}...${token.slice(-4)}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const supaUrl = process.env.SUPABASE_URL!;
  const supaServiceRole = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  // Two acceptable auth paths:
  //   1. Server-to-server: X-Internal-Secret == PUSH_FANOUT_SECRET (e.g. from a future Supabase trigger)
  //   2. Authenticated user: Authorization: Bearer <Supabase JWT> (current iOS path)
  // Reject if neither.
  const internalSecret = req.headers["x-internal-secret"];
  const authHeader = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");

  let authedUserId: string | null = null;
  if (internalSecret && internalSecret === process.env.PUSH_FANOUT_SECRET) {
    // server-to-server path: trust caller, no user attribution
  } else if (authHeader) {
    const userRes = await fetch(`${supaUrl}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY!, Authorization: `Bearer ${authHeader}` },
    });
    if (!userRes.ok) {
      return res.status(401).json({ error: "invalid_jwt" });
    }
    const userJson = (await userRes.json()) as { id?: string };
    if (!userJson.id) {
      return res.status(401).json({ error: "invalid_jwt" });
    }
    authedUserId = userJson.id;
  } else {
    return res.status(401).json({ error: "unauthorized" });
  }

  const body = req.body as PushBody;
  if (!body.node_id || !body.author_user_id || !body.title || !body.body) {
    return res.status(400).json({ error: "missing_params" });
  }

  // If the caller is a user, the author_user_id MUST match their JWT identity.
  // Prevents one user from spamming push fan-out as if they were another user.
  if (authedUserId && authedUserId !== body.author_user_id) {
    return res.status(403).json({ error: "author_mismatch" });
  }

  const supaHeaders = {
    apikey: supaServiceRole,
    Authorization: `Bearer ${supaServiceRole}`,
    "content-type": "application/json",
  };

  // If the caller is a user, verify they are actually a member of the target node.
  // Without this check, knowing a node_id (UUID, hard to guess but not unguessable) would let
  // an arbitrary user spam push to that node's members.
  if (authedUserId) {
    const memberCheck = await fetch(
      `${supaUrl}/rest/v1/memberships?select=user_id&node_id=eq.${body.node_id}&user_id=eq.${authedUserId}`,
      { headers: supaHeaders },
    );
    const memberRows = (await memberCheck.json()) as { user_id: string }[];
    if (!memberRows.length) {
      return res.status(403).json({ error: "not_a_member" });
    }
  }

  const membersRes = await fetch(
    `${supaUrl}/rest/v1/memberships?select=user_id,device_token&node_id=eq.${body.node_id}`,
    { headers: supaHeaders },
  );
  if (!membersRes.ok) {
    return res.status(502).json({ error: "membership_fetch_failed" });
  }
  const members = (await membersRes.json()) as MembershipRow[];
  const targets = members.filter((m) => m.user_id !== body.author_user_id && !!m.device_token);

  const APNS_KEY_ID = process.env.APNS_KEY_ID!;
  const APNS_TEAM_ID = process.env.APNS_TEAM_ID!;
  const APNS_PRIVATE_KEY = process.env.APNS_PRIVATE_KEY!;
  const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID!;

  const apnsToken = jwt.sign({}, APNS_PRIVATE_KEY, {
    algorithm: "ES256",
    header: { alg: "ES256", kid: APNS_KEY_ID },
    issuer: APNS_TEAM_ID,
    expiresIn: "1h",
  } as jwt.SignOptions);

  const payload = JSON.stringify({
    aps: {
      alert: { title: body.title, body: body.body },
      sound: "default",
      "thread-id": body.category ?? "node-update",
    },
    node_id: body.node_id,
  });

  const failures: { token_masked: string; status: number; reason?: string }[] = [];
  const deadTokens: string[] = [];

  for (const target of targets) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), APNS_REQUEST_TIMEOUT_MS);
    let apnsRes: Response;
    try {
      apnsRes = await fetch(`${APNS_HOST}/3/device/${target.device_token}`, {
        method: "POST",
        headers: {
          authorization: `bearer ${apnsToken}`,
          "apns-topic": APNS_BUNDLE_ID,
          "apns-push-type": "alert",
          "content-type": "application/json",
        },
        body: payload,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const reason = err instanceof Error && err.name === "AbortError" ? "timeout" : "network_error";
      failures.push({ token_masked: maskToken(target.device_token!), status: 0, reason });
      continue;
    }
    clearTimeout(timer);

    if (apnsRes.ok) continue;

    let reason: string | undefined;
    try {
      reason = ((await apnsRes.json()) as { reason?: string })?.reason;
    } catch { /* APNs returns no body on some errors */ }

    failures.push({
      token_masked: maskToken(target.device_token!),
      status: apnsRes.status,
      reason,
    });

    if (apnsRes.status === 410 || (reason && DEAD_TOKEN_REASONS.has(reason))) {
      deadTokens.push(target.device_token!);
    }
  }

  if (deadTokens.length > 0) {
    // Best-effort cleanup. Failure to clear a token is non-fatal -- next push will try again.
    await fetch(
      `${supaUrl}/rest/v1/memberships?device_token=in.(${deadTokens.map((t) => `"${t}"`).join(",")})`,
      {
        method: "PATCH",
        headers: supaHeaders,
        body: JSON.stringify({ device_token: null }),
      },
    ).catch(() => { /* swallow; logged via failures count */ });
  }

  return res.status(200).json({
    ok: true,
    targets: targets.length,
    delivered: targets.length - failures.length,
    failures: failures.length,
    cleaned_dead_tokens: deadTokens.length,
    failure_detail: failures,
  });
}
