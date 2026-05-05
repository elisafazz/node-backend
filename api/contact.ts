import type { VercelRequest, VercelResponse } from "@vercel/node";

// Renders /contact at request time so CONTACT_EMAIL from Vercel env vars is substituted live.
// Static HTML at /pages/contact.html is intentionally not used; vercel.json routes /contact here.
export default function handler(_req: VercelRequest, res: VercelResponse) {
  const email = process.env.CONTACT_EMAIL;
  const emailHtml = email
    ? `<a class="email" href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`
    : `<span class="email">[contact email not configured]</span>`;

  const body = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Node -- Contact</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #222; }
    h1 { font-size: 1.6rem; }
    h2 { font-size: 1.2rem; margin-top: 2rem; }
    .email { font-family: ui-monospace, monospace; background: #f4f4f4; padding: 4px 8px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Contact Node</h1>
  <p>For abuse reports, account questions, or anything else:</p>
  <p>Email: ${emailHtml}</p>

  <h2>Reports of abuse, harassment, or illegal content</h2>
  <p>The fastest path to action is the in-app Report option on the specific story, photo, thought, member, or node. The report queue is monitored continuously.</p>
  <p>Time commitments per <a href="/tos">our Terms of Service</a>:</p>
  <ul>
    <li>Imminent harm, harassment, or illegal content: within 48 hours</li>
    <li>All other reports: within 7 days</li>
  </ul>

  <h2>Account questions</h2>
  <p>You can delete your account from in-app Settings. The deletion is irreversible and removes your data, your media, and your authentication grant. See the <a href="/privacy">Privacy Policy</a> for the full cascade.</p>

  <p><a href="/tos">Terms of Service</a> | <a href="/privacy">Privacy Policy</a> | <a href="/eula">EULA</a></p>
</body>
</html>`;

  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "public, max-age=300");
  res.status(200).send(body);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
