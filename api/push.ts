// Vercel API: /api/push
// APNs fan-out for Node app.
// Called by iOS (or by a Supabase Edge Function trigger -- TBD) when a new story is posted.
// Reads device tokens for all members of a node EXCEPT the author, sends APNs notification to each.

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const authHeader = req.headers["x-internal-secret"];
  if (authHeader !== process.env.PUSH_FANOUT_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const body = req.body as PushBody;
  if (!body.node_id || !body.author_user_id || !body.title || !body.body) {
    return res.status(400).json({ error: "missing_params" });
  }

  // Pull device tokens via Supabase service role
  const supaUrl = process.env.SUPABASE_URL!;
  const supaServiceRole = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const membersRes = await fetch(
    `${supaUrl}/rest/v1/memberships?select=user_id,device_token&node_id=eq.${body.node_id}`,
    { headers: { "apikey": supaServiceRole, "Authorization": `Bearer ${supaServiceRole}` } },
  );
  if (!membersRes.ok) {
    return res.status(502).json({ error: "membership_fetch_failed" });
  }
  const members = (await membersRes.json()) as MembershipRow[];
  const targets = members.filter((m) => m.user_id !== body.author_user_id && !!m.device_token);

  // Build APNs auth token (ES256-signed JWT)
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

  // Send to each target. Apple HTTP/2 multiplexes; we send sequentially for simplicity at v1 size (max 9 targets per node).
  const failures: { token: string; status: number; reason?: string }[] = [];
  for (const target of targets) {
    const payload = JSON.stringify({
      aps: {
        alert: { title: body.title, body: body.body },
        sound: "default",
        "thread-id": body.category ?? "node-update",
      },
      node_id: body.node_id,
    });
    const apnsRes = await fetch(`${APNS_HOST}/3/device/${target.device_token}`, {
      method: "POST",
      headers: {
        "authorization": `bearer ${apnsToken}`,
        "apns-topic": APNS_BUNDLE_ID,
        "apns-push-type": "alert",
        "content-type": "application/json",
      },
      body: payload,
    });
    if (!apnsRes.ok) {
      let reason: string | undefined;
      try { reason = (await apnsRes.json() as { reason?: string })?.reason; } catch { /* ignore */ }
      failures.push({ token: target.device_token!, status: apnsRes.status, reason });
    }
  }

  return res.status(200).json({
    ok: true,
    targets: targets.length,
    failures: failures.length,
    failure_detail: failures,
  });
}
