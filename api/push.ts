// Vercel API: /api/push
// APNs fan-out for Node app.
// Called by iOS (or by a Supabase Edge Function trigger) when a new story is posted.
// Reads device tokens for all members of a node EXCEPT the author, sends APNs notification to each.
// Cleans up dead tokens (Apple-reported BadDeviceToken / Unregistered) so we do not retry them.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import jwt from "jsonwebtoken";

interface PushBody {
  // Legacy single-node fan-out. Either node_id or node_ids must be provided, not both.
  node_id?: string;
  // Multi-node fan-out. Used by cross-node features (Stories, Boop, Meeting confirm).
  // The server unions memberships across every node and dedupes recipients by user_id,
  // so a user in N of the target nodes still receives exactly one push.
  node_ids?: string[];
  author_user_id: string;
  title: string;
  body: string;
  category?: string;
}

interface MembershipRow {
  user_id: string;
}

interface DeviceTokenRow {
  user_id: string;
  token: string;
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

  // Normalize to a node_ids array. Accept either node_id or node_ids; reject empty/both.
  const nodeIds: string[] = Array.isArray(body.node_ids) && body.node_ids.length > 0
    ? body.node_ids
    : (body.node_id ? [body.node_id] : []);

  if (nodeIds.length === 0 || !body.author_user_id || !body.title || !body.body) {
    return res.status(400).json({ error: "missing_params" });
  }

  // Truncate to APNs-safe lengths before embedding in the JSON payload.
  // APNs total payload limit is 4096 bytes; 100+200 chars leaves ample room for
  // the aps envelope, thread-id, node_ids array, and JSON framing.
  const safeTitle = body.title.slice(0, 100);
  const safeBody = body.body.slice(0, 200);

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

  // If the caller is a user, verify they are actually a member of EVERY target node.
  // Without this check, knowing a node_id would let an arbitrary user spam push to that node's members.
  if (authedUserId) {
    const inList = nodeIds.map((id) => `"${id}"`).join(",");
    const memberCheck = await fetch(
      `${supaUrl}/rest/v1/memberships?select=node_id&user_id=eq.${authedUserId}&node_id=in.(${inList})`,
      { headers: supaHeaders },
    );
    const memberRows = (await memberCheck.json()) as { node_id: string }[];
    const callerNodeIds = new Set(memberRows.map((r) => r.node_id));
    const missing = nodeIds.filter((id) => !callerNodeIds.has(id));
    if (missing.length > 0) {
      return res.status(403).json({ error: "not_a_member", missing });
    }
  }

  // Step 1: get unique recipient user_ids from memberships (all target nodes, minus author).
  const inList = nodeIds.map((id) => `"${id}"`).join(",");
  const membersRes = await fetch(
    `${supaUrl}/rest/v1/memberships?select=user_id&node_id=in.(${inList})`,
    { headers: supaHeaders },
  );
  if (!membersRes.ok) {
    return res.status(502).json({ error: "membership_fetch_failed" });
  }
  const members = (await membersRes.json()) as MembershipRow[];
  const recipientUserIds = [...new Set(
    members
      .map((m) => m.user_id)
      .filter((uid) => uid !== body.author_user_id)
  )];

  // Step 2: look up every registered device token for those users.
  // One user with 2 devices will have 2 rows -- both get a push.
  // Two users in 3 shared nodes each get only one fetch here (deduped in step 1).
  interface Target { user_id: string; device_token: string }
  const targets: Target[] = [];

  if (recipientUserIds.length > 0) {
    const uidList = recipientUserIds.map((id) => `"${id}"`).join(",");
    const tokensRes = await fetch(
      `${supaUrl}/rest/v1/device_tokens?select=user_id,token&user_id=in.(${uidList})`,
      { headers: supaHeaders },
    );
    if (tokensRes.ok) {
      const rows = (await tokensRes.json()) as DeviceTokenRow[];
      for (const row of rows) {
        targets.push({ user_id: row.user_id, device_token: row.token });
      }
    }
    // If device_tokens query fails, targets stays empty -- no push is better than crashing.
  }

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
      alert: { title: safeTitle, body: safeBody },
      sound: "default",
      "thread-id": body.category ?? "node-update",
    },
    // Send the first target node as a deeplink hint. Multi-node sends embed all node_ids
    // so the client can route to the most relevant one.
    node_id: nodeIds[0],
    node_ids: nodeIds,
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
    // Best-effort cleanup from device_tokens table.
    // Failure is non-fatal -- the token will just be retried on next push.
    await fetch(
      `${supaUrl}/rest/v1/device_tokens?token=in.(${deadTokens.map((t) => `"${t}"`).join(",")})`,
      { method: "DELETE", headers: supaHeaders },
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
