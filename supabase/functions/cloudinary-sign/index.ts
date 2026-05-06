// Edge Function: cloudinary-sign
// Returns a signed Cloudinary upload payload for the iOS client.
// Folder convention:
//   - kind="story" -> user/{author_user_id}/stories/   (stories are author-owned, cross-node per ADR-012)
//   - kind="photo" -> node/{node_id}/photos/           (photos remain per-node)
//
// Request body:
//   { "kind": "story" }                  // node_id ignored
//   { "kind": "photo", "node_id": "uuid" }
// Returns: { signature, timestamp, api_key, cloud_name, folder, upload_preset }

// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "missing_auth" }), { status: 401 });
  }

  let body: { node_id?: string; kind?: string };
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "invalid_body" }), { status: 400 });
  }
  if (body.kind !== "story" && body.kind !== "photo") {
    return new Response(JSON.stringify({ error: "invalid_kind" }), { status: 400 });
  }
  if (body.kind === "photo" && !body.node_id) {
    return new Response(JSON.stringify({ error: "node_id_required_for_photo" }), { status: 400 });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ error: "auth_failed" }), { status: 401 });
  }

  // Photos: verify per-node membership. Stories: any authenticated user can upload to their own folder.
  if (body.kind === "photo") {
    const { data: membership } = await userClient
      .from("memberships")
      .select("id")
      .eq("node_id", body.node_id)
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!membership) {
      return new Response(JSON.stringify({ error: "not_a_member" }), { status: 403 });
    }
  }

  const CLOUDINARY_CLOUD_NAME = Deno.env.get("CLOUDINARY_CLOUD_NAME")!;
  const CLOUDINARY_API_KEY = Deno.env.get("CLOUDINARY_API_KEY")!;
  const CLOUDINARY_API_SECRET = Deno.env.get("CLOUDINARY_API_SECRET")!;
  const UPLOAD_PRESET = Deno.env.get("CLOUDINARY_UPLOAD_PRESET_NODE") ?? "node-uploads-signed";

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = body.kind === "story"
    ? `user/${userData.user.id}/stories`
    : `node/${body.node_id}/photos`;

  // Cloudinary signature: SHA-1 of "param1=value1&param2=value2..." sorted alphabetically + API secret
  const paramsToSign: Record<string, string> = {
    folder,
    timestamp: String(timestamp),
    upload_preset: UPLOAD_PRESET,
  };
  const sortedKeys = Object.keys(paramsToSign).sort();
  const toSign = sortedKeys.map((k) => `${k}=${paramsToSign[k]}`).join("&");
  const signature = await sha1Hex(toSign + CLOUDINARY_API_SECRET);

  return new Response(JSON.stringify({
    signature,
    timestamp,
    api_key: CLOUDINARY_API_KEY,
    cloud_name: CLOUDINARY_CLOUD_NAME,
    folder,
    upload_preset: UPLOAD_PRESET,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
});

async function sha1Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
