// Edge Function: report-intake
// Receives a UGC report from iOS, inserts into public.reports, sends email to CONTACT_EMAIL.
//
// Request body:
//   { node_id?: uuid, target_kind: 'story'|'photo'|'thought'|'user'|'node', target_id: uuid, reason: text }

// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "missing_auth" }), { status: 401 });
  }

  let body: { node_id?: string; target_kind?: string; target_id?: string; reason?: string };
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "invalid_body" }), { status: 400 });
  }
  const validKinds = ["story", "photo", "thought", "user", "node"];
  if (!body.target_kind || !validKinds.includes(body.target_kind) || !body.target_id || !body.reason) {
    return new Response(JSON.stringify({ error: "invalid_params" }), { status: 400 });
  }
  if (body.reason.length > 1000) {
    return new Response(JSON.stringify({ error: "reason_too_long" }), { status: 400 });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SUPABASE_SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ error: "auth_failed" }), { status: 401 });
  }
  const reporterId = userData.user.id;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

  const { data: report, error: insertErr } = await admin.from("reports").insert({
    reporter_user_id: reporterId,
    node_id: body.node_id ?? null,
    target_kind: body.target_kind,
    target_id: body.target_id,
    reason: body.reason,
  }).select().single();

  if (insertErr) {
    console.error("report_insert_failed", insertErr);
    return new Response(JSON.stringify({ error: "storage_failed" }), { status: 500 });
  }

  // Email notification: best-effort; do not fail the request if email fails.
  // Always log to Supabase logs for forensic trail. If Resend is configured, also send email
  // so Elisa sees reports within the SLA committed to in /tos ("48 hours imminent harm; 7 days otherwise").
  const contactEmail = Deno.env.get("CONTACT_EMAIL");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const resendFrom = Deno.env.get("RESEND_FROM") ?? "reports@node.elisafazzari.com";

  console.info(JSON.stringify({
    event: "ugc_report",
    report_id: report.id,
    reporter_user_id: reporterId,
    target_kind: body.target_kind,
    target_id: body.target_id,
    reason: body.reason.substring(0, 200),
    contact_email: contactEmail ?? "(unset)",
    email_sent: false,
  }));

  if (contactEmail && resendApiKey) {
    try {
      const subject = `[Node UGC report] ${body.target_kind} ${body.target_id}`;
      const text = [
        `Report ID: ${report.id}`,
        `Reporter: ${reporterId}`,
        `Node: ${body.node_id ?? "(none)"}`,
        `Target kind: ${body.target_kind}`,
        `Target id: ${body.target_id}`,
        ``,
        `Reason:`,
        body.reason,
      ].join("\n");

      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: resendFrom,
          to: [contactEmail],
          subject,
          text,
        }),
      });
      if (!emailRes.ok) {
        const errBody = await emailRes.text().catch(() => "");
        console.error("resend_email_failed", emailRes.status, errBody.substring(0, 500));
      } else {
        console.info("ugc_report_emailed", report.id);
      }
    } catch (emailErr) {
      console.error("resend_email_throw", emailErr instanceof Error ? emailErr.message : String(emailErr));
    }
  } else if (!resendApiKey) {
    console.warn("RESEND_API_KEY unset -- report logged only. Set RESEND_API_KEY + CONTACT_EMAIL to enable email delivery.");
  }

  return new Response(JSON.stringify({ ok: true, report_id: report.id }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
