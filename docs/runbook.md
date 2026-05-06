# Node Backend -- Operations Runbook

What to do when something is on fire. Every section: symptom, diagnostic command, fix.

For one-time setup, see `~/Dropbox/claude/node/SETUP-WALKTHROUGH.md`. This file is for steady-state operations.

---

## Quick reference

```
Vercel project        node-backend
Vercel deploy URL     https://node-backend-<hash>.vercel.app (alias: node-app-backend.vercel.app)
Supabase project      node-prod  (region us-west-1)
GitHub repo           elisafazz/node-backend (main = production)
Local code            ~/Dropbox/claude_work/node-backend/
Secrets dir           ~/Dropbox/claude-secrets/node/  (NEVER commit)
```

Health check (run anytime):
```bash
cd ~/Dropbox/claude_work/node-backend
VERCEL_URL=https://node-app-backend.vercel.app \
SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_ANON_KEY=<key> \
./scripts/verify-deploy.sh
```

---

## Push notifications stopped working

**Symptom**: posting a story does not push to other devices in the node.

**Diagnose, in order:**

1. Curl the push endpoint directly:
   ```
   curl -X POST https://node-app-backend.vercel.app/api/push -H "content-type: application/json" -d '{}'
   ```
   - 4xx response = function alive, your client request was malformed
   - 5xx response = function failing internally; go to Vercel logs
   - Connection refused / 404 = deployment broken; redeploy

2. Read Vercel logs: `vercel logs node-backend --prod` (or via dashboard).

3. Common causes:
   - **APNs key expired or revoked**: Apple Developer Console > Keys > confirm the APNs key still exists. Apple does not auto-rotate; the key only stops working if you (or someone) revoked it.
   - **APNs JWT signature wrong**: `APNS_KEY_ID`, `APNS_TEAM_ID`, or `APNS_PRIVATE_KEY` env var on Vercel is wrong. Verify with `vercel env ls`.
   - **Sandbox vs production mismatch**: `APNS_PRODUCTION=false` is for TestFlight builds. Set `true` only after the App Store version ships. A TestFlight build cannot receive sandbox push if APNS_PRODUCTION=true (and vice versa).
   - **Device token stale**: device tokens rotate. The iOS app re-registers on every launch and writes the fresh token to `memberships.device_token`. If a token is older than ~30 days unused, APNs returns BadDeviceToken; verify the iOS app is still calling the registration endpoint.

**Fix**: most often a key/env var rotation. Update on Vercel dashboard, redeploy with `vercel --prod`.

---

## Sign in with Apple is broken

**Symptom**: iOS app reaches Apple sheet, authorizes, then falls back to LoginView with no session.

**Diagnose, in order:**

1. Open Supabase dashboard > Authentication > Users. Did a new auth.users row get created at the time of the attempted sign-in?
   - **Yes**: the Apple flow worked but our Edge Function failed. Go to step 2.
   - **No**: the Apple flow itself failed. Go to step 4.

2. Open Supabase dashboard > Edge Functions > apple-exchange-code > Logs. Look for the most recent invocation.

3. Common Edge Function errors:
   - **Apple `/auth/token` returns invalid_client**: `APPLE_SERVICE_ID` is wrong, OR `APPLE_TEAM_ID` is wrong, OR `APPLE_KEY_ID` is wrong. Check that all three match Apple Developer Console exactly. The service ID is `com.elisafazzari.node.signin` (NOT `node.siwa` -- prior drift, fixed).
   - **Apple `/auth/token` returns invalid_grant**: the authorization code Apple returned to iOS was already used or expired. Codes expire in 5 minutes and are single-use. The iOS app may be retrying with a stale code. Sign out, sign back in.
   - **JWT signature invalid**: `APPLE_PRIVATE_KEY` env var content is wrong. The .p8 file content must include the BEGIN/END PRIVATE KEY lines and preserve newlines. When pasting via `supabase secrets set`, prefer reading from a file.

4. Apple-side failures:
   - **"Sign in with Apple is not available"**: device is not signed into iCloud. Sign in via Settings.
   - **Apple sheet does not appear**: `Sign In with Apple` capability missing from the Xcode entitlements OR the Service ID is misconfigured. Compare against Sunzzari/Miracles configs.

**Fix**: rotate the affected secret on Supabase via `supabase secrets set <KEY>=<value>`, redeploy the Edge Function with `supabase functions deploy apple-exchange-code`, retry sign-in.

---

## Account deletion partially failed

**Symptom**: user reports "I deleted my account but my photos are still there" or RLS errors after a deletion.

**This is critical.** Apple Guideline 5.1.1(v) requires the deletion to be complete. Investigate within 24 hours.

**Diagnose:**

1. Open Supabase dashboard > Database > `private.deletion_requests`. Find the audit row for the user. Note the timestamp.
2. Open Supabase Edge Functions > delete-user-data > Logs. Pull the invocation matching that timestamp.
3. The cascade is: `apple-revoke` -> Cloudinary scrub -> table DELETEs -> `auth.users` DELETE. Find which step failed.

**Common failure modes and fixes:**

- **Apple revoke timed out or returned 5xx**: Apple's `/auth/revoke` is occasionally flaky. Re-run the function for that user with `supabase functions invoke delete-user-data --no-verify-jwt -d '{"userId":"<uuid>","force":true}'` (force=true skips the audit re-insert).
- **Cloudinary scrub failed mid-way**: orphaned Cloudinary assets exist but the database row was deleted. There is no automatic recovery. Manual fix: in Cloudinary dashboard, delete the `node/<userId>/` folder by hand.
- **DELETE on a public table failed due to RLS**: the function runs as service_role which bypasses RLS, so this should not happen. If it does, check the function deployment is not stale (redeploy).

---

## Edge Function CPU / memory exhaustion

**Symptom**: Edge Function returns 500 with "function exceeded resource limits."

Supabase Edge Functions on the free tier have limits:
- 100 ms CPU time per request
- 150 MB memory
- 50 MB / function bundle size

**Diagnose**: dashboard > Edge Functions > <function> > Metrics. CPU and memory graphs.

**Fix**:
- The most-likely-to-hit limit is `delete-user-data` if a user has thousands of photos. The Cloudinary scrub iterates all assets sequentially.
- Mitigation: paginate the scrub (delete 100 at a time, return early, the iOS client retries until done). Not yet implemented; add when first user hits this.

---

## Cloudinary signed-upload failures

**Symptom**: iOS app fails to upload a photo with a signature mismatch error.

**Cause**: the iOS app and `cloudinary-sign` Edge Function disagree about which params are signed.

**Diagnose**: Edge Function logs > confirm the params in the signed request match the params in the iOS upload request. The signed string uses ALL params except `file`, `cloud_name`, `resource_type`, and `api_key`, sorted alphabetically.

**Fix**: most often the iOS app added a new parameter (e.g. `tags`, `transformation`) that the Edge Function does not include in its signature. Either (a) include it in the Edge Function's signature, or (b) drop it from the iOS upload request.

---

## RLS denied a query that should have worked

**Symptom**: iOS app reports "permission denied" or "row-level security violated."

**Diagnose**:

1. Confirm the user is authenticated: Supabase dashboard > Authentication > Users. They should appear with a recent `last_sign_in_at`.
2. Confirm the user is a member of the node they are trying to access: dashboard > Database > `public.memberships` > filter `user_id` and `node_id`.
3. If they are a member but the query still fails, the RLS policy is wrong. Read `migrations/0001_init.sql` and the relevant `create policy` statement.

**Common causes**:
- **Realtime subscription without an active session**: the iOS Supabase SDK lost the session. App-side fix: refresh the session before subscribing.
- **`is_member_of()` helper used incorrectly**: should be `is_member_of(node_id, auth.uid())`, not the other way around. Check the policy text.

---

## Rotating Apple keys (annual or after compromise)

Apple keys do NOT auto-expire, but you may want to rotate annually as a hygiene practice or immediately if a key was committed to a public repo.

**Procedure**:

1. Generate a new key in Apple Developer Console > Keys > + > enable Sign In with Apple.
2. Download the new .p8. Note the new Key ID.
3. Update env vars:
   ```
   supabase secrets set APPLE_KEY_ID=<new-id>
   supabase secrets set APPLE_PRIVATE_KEY="$(cat ~/Dropbox/claude-secrets/node/AuthKey_SIWA_NEW.p8)"
   vercel env add APPLE_KEY_ID  # update
   vercel env add APPLE_PRIVATE_KEY  # update (or use file path)
   ```
4. Redeploy:
   ```
   supabase functions deploy apple-exchange-code apple-revoke
   vercel --prod
   ```
5. Sign in on a test device to confirm.
6. Only AFTER the new key is confirmed working: revoke the old key in Apple Developer Console.

Same procedure for the APNs key (rotate `APNS_KEY_ID` + `APNS_PRIVATE_KEY`, redeploy `api/push`).

---

## "I think someone is brute-forcing invite codes"

**Symptom**: high traffic on `join_node_by_invite_code` RPC.

**Built-in defense**: the `invite_code_attempts` table rate-limits to 10 attempts per user per hour. Past 10, the RPC returns `error: rate_limited` without checking the code.

**Diagnose**:
```sql
select user_id, count(*) as attempts, min(attempted_at), max(attempted_at)
from public.invite_code_attempts
where attempted_at > now() - interval '24 hours'
group by user_id
order by attempts desc
limit 20;
```

A user with hundreds of attempts is suspicious.

**Fix**:
- Force-revoke their session: `update auth.users set banned_until = now() + interval '7 days' where id = '<uuid>';`
- Tighten the rate limit if abuse is widespread: edit the `join_node_by_invite_code` RPC to lower the threshold (currently 10/hr; could go to 5/hr).
- Add an IP-based rate limit at the Vercel layer if abuse moves to a different Supabase user identity.

---

## Reverting a bad deploy

**Vercel** auto-deploys main on push. If a deploy is broken:

```
cd ~/Dropbox/claude_work/node-backend
git log --oneline -5
git revert <bad-commit>
git push
```

Vercel auto-deploys the revert. Or via dashboard: Deployments > previous good deployment > Promote to Production. Faster, no commit needed.

**Supabase migrations** have no equivalent of revert. If a migration broke the schema:
1. Write a new migration that undoes it (`0003_revert_thing.sql`).
2. `supabase db push`.
3. Never edit a migration that has been applied to production.

---

## When in doubt

1. Run `./scripts/verify-deploy.sh`. Half the time the answer is in the failure output.
2. Check `git log` and `vercel logs` against the time the user reports the issue.
3. Read this file again. The fix is probably already documented.
4. If genuinely new: add a new section to this runbook before you forget.
