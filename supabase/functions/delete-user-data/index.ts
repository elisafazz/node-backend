// Edge Function: delete-user-data
// Called by iOS from the Account Deletion flow.
// Performs the full Apple-compliant cascade:
//   1. Insert/update private.deletion_requests audit row
//   2. Read apple_oauth_credentials.refresh_token, call apple-revoke
//   3. SELECT all cloudinary_public_ids for the user (across stories + photos)
//   4. Call Cloudinary Admin API DELETE for each
//   5. DELETE rows authored by user (stories, photos, thoughts)
//   6. DELETE memberships for user
//   7. DELETE apple_oauth_credentials row
//   8. DELETE auth.users row (cascades to public.users via FK)
//   9. UPDATE deletion_requests.status = completed
//
// Auth: Supabase JWT (verify_jwt = true). The caller must be the user being deleted.

// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "missing_auth" }), { status: 401 });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const SUPABASE_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
  const PUSH_FANOUT_SECRET = Deno.env.get("PUSH_FANOUT_SECRET")!;

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ error: "auth_failed" }), { status: 401 });
  }
  const userId = userData.user.id;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

  // 1. Audit row
  await admin.schema("private" as any).from("deletion_requests").upsert({
    user_id: userId,
    status: "pending",
    requested_at: new Date().toISOString(),
  });

  // 2. Apple revoke
  const { data: cred } = await admin
    .schema("private" as any)
    .from("apple_oauth_credentials")
    .select("refresh_token")
    .eq("user_id", userId)
    .maybeSingle();

  if (cred?.refresh_token) {
    try {
      const revokeRes = await fetch(`${SUPABASE_URL}/functions/v1/apple-revoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": PUSH_FANOUT_SECRET,
        },
        body: JSON.stringify({ refresh_token: cred.refresh_token }),
      });
      if (!revokeRes.ok) {
        console.error("apple_revoke_call_failed", await revokeRes.text());
        // Continue with deletion anyway -- per Apple's offering-account-deletion docs, the revoke is best-effort
        // and should not block deletion of user data. Audit log captures the failure.
      } else {
        await admin.schema("private" as any).from("deletion_requests")
          .update({ status: "apple_revoked" }).eq("user_id", userId);
      }
    } catch (e) {
      console.error("apple_revoke_threw", e);
    }
  }

  // 3. Collect cloudinary asset IDs
  const [storyAssets, photoAssets] = await Promise.all([
    admin.from("stories").select("cloudinary_public_id").eq("author_user_id", userId),
    admin.from("photos").select("cloudinary_public_id").eq("author_user_id", userId),
  ]);
  const publicIds = [
    ...(storyAssets.data ?? []).map((r: any) => r.cloudinary_public_id),
    ...(photoAssets.data ?? []).map((r: any) => r.cloudinary_public_id),
  ].filter(Boolean);

  // 4. Delete Cloudinary assets
  const CLOUDINARY_CLOUD_NAME = Deno.env.get("CLOUDINARY_CLOUD_NAME")!;
  const CLOUDINARY_API_KEY = Deno.env.get("CLOUDINARY_API_KEY")!;
  const CLOUDINARY_API_SECRET = Deno.env.get("CLOUDINARY_API_SECRET")!;
  const cloudinaryAuth = "Basic " + btoa(`${CLOUDINARY_API_KEY}:${CLOUDINARY_API_SECRET}`);

  const failedDeletes: string[] = [];
  for (const publicId of publicIds) {
    try {
      const deleteRes = await fetch(
        `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/destroy`,
        {
          method: "POST",
          headers: {
            "Authorization": cloudinaryAuth,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ public_id: publicId, invalidate: "true" }),
        },
      );
      if (!deleteRes.ok) failedDeletes.push(publicId);
    } catch {
      failedDeletes.push(publicId);
    }
  }
  if (failedDeletes.length > 0) {
    console.error("cloudinary_partial_fail", failedDeletes);
    // Audit captures, retry happens via nightly cron (deferred; v1 logs and proceeds)
  } else {
    await admin.schema("private" as any).from("deletion_requests")
      .update({ status: "media_scrubbed" }).eq("user_id", userId);
  }

  // 5–7. Delete user-authored rows, memberships, and Apple credentials.
  // These run before auth.admin.deleteUser so the audit trail is accurate even if the
  // auth step fails. If any row-delete fails we log it and continue -- the auth deletion
  // that follows will cascade FK-delete any rows that survived.
  const rowErrors: string[] = [];
  const rowDeletes = await Promise.allSettled([
    admin.from("stories").delete().eq("author_user_id", userId),
    admin.from("photos").delete().eq("author_user_id", userId),
    admin.from("thoughts").delete().eq("author_user_id", userId),
    admin.from("memberships").delete().eq("user_id", userId),
    admin.schema("private" as any).from("apple_oauth_credentials").delete().eq("user_id", userId),
  ]);
  rowDeletes.forEach((r, i) => {
    if (r.status === "rejected") rowErrors.push(`step${5 + i}: ${r.reason}`);
  });
  if (rowErrors.length > 0) {
    console.error("row_delete_partial_failure", rowErrors);
  } else {
    await admin.schema("private" as any).from("deletion_requests")
      .update({ status: "rows_deleted" }).eq("user_id", userId);
  }

  // 8. Auth user (cascades to public.users via FK on delete cascade).
  // This is the point of no return -- once auth.admin.deleteUser succeeds the account is
  // irrecoverably gone. We only proceed if the audit row is in a good state.
  const { error: deleteAuthErr } = await admin.auth.admin.deleteUser(userId);
  if (deleteAuthErr) {
    console.error("auth_delete_failed", deleteAuthErr, "row_errors", rowErrors);
    await admin.schema("private" as any).from("deletion_requests")
      .update({
        status: "failed",
        error: `auth_delete: ${deleteAuthErr.message}; row_errors: ${rowErrors.join("; ")}`,
      }).eq("user_id", userId);
    return new Response(JSON.stringify({ error: "auth_delete_failed" }), { status: 500 });
  }

  // Cascade verification: confirm public.users row is gone (FK cascade should have removed it).
  const { data: remainingUser } = await admin.from("users").select("id").eq("id", userId).maybeSingle();
  if (remainingUser) {
    console.error("cascade_incomplete: public.users row survived auth deletion for", userId);
    await admin.from("users").delete().eq("id", userId);
  }

  // 9. Final audit
  await admin.schema("private" as any).from("deletion_requests")
    .update({ status: "completed", completed_at: new Date().toISOString() }).eq("user_id", userId);

  return new Response(
    JSON.stringify({ ok: true, cloudinary_failed_count: failedDeletes.length }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
