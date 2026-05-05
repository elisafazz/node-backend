# node-backend

Backend for the Node iOS app. Two surfaces:

1. **Vercel API** (`/api/*`) -- a small Node/TypeScript server that handles APNs push fan-out. Vercel hosts static legal pages too (`/tos`, `/privacy`, `/eula`, `/contact`).
2. **Supabase Edge Functions** (`supabase/functions/*`) -- Apple Sign in with Apple code exchange, Apple token revocation, account deletion cascade with Cloudinary asset scrubbing, signed Cloudinary upload URLs, UGC report intake.

The database schema, RLS policies, and security-definer RPC functions live in `supabase/migrations/` and are applied via the Supabase CLI.

## Setup

```bash
npm install

# 1. Supabase project -- create one at https://supabase.com/dashboard
supabase login
supabase link --project-ref <your-project-ref>
supabase db push  # applies migrations/0001_init.sql

# 2. Deploy Edge Functions
npm run supabase:functions:deploy:all

# 3. Vercel project -- link this repo to a Vercel project
vercel link

# 4. Set env vars on both Supabase Edge Functions and Vercel
# See .env.example for the full list. Highlights:
# - SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
# - APPLE_TEAM_ID, APPLE_SERVICE_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY (.p8 contents)
# - APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY, APNS_BUNDLE_ID
# - CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, CLOUDINARY_UPLOAD_PRESET_NODE
# - CONTACT_EMAIL, PUSH_FANOUT_SECRET (random 32+ char string)
```

## Architecture

See `~/Dropbox/claude/node/architecture-decision-log.md` for the full ADR set. Key design decisions:

- **ADR-004**: Supabase Auth does not expose the Apple `provider_refresh_token`, so we capture and store it ourselves via `apple-exchange-code` Edge Function. Required for Apple-compliant account deletion.
- **ADR-005**: Invite-code-only privacy. Join flow uses a `security definer` Postgres function to bypass RLS for the invite-code lookup.
- **ADR-006**: UGC compliance via zero-tolerance EULA + report-and-remove queue. No automated content moderation in v1.
- **ADR-007**: Account deletion cascade includes Apple `/auth/revoke` + Cloudinary asset scrubbing.
- **ADR-008**: Realtime subscriptions only on `stories`. Other tables use polling to conserve egress.

## Repository layout

```
node-backend/
  api/
    push.ts                 # Vercel: APNs fan-out
  pages/
    tos.html
    privacy.html
    eula.html
    contact.html
  scripts/
    smoke-test.mjs          # TBD: end-to-end smoke tests against dev environment
  supabase/
    config.toml
    migrations/
      0001_init.sql         # Full schema, RLS, RPCs
    functions/
      apple-exchange-code/
      apple-revoke/
      delete-user-data/
      cloudinary-sign/
      report-intake/
  vercel.json
  package.json
  tsconfig.json
  .env.example
  .gitignore
```

## Deploy flow

1. Edit + commit + push -> auto-deploys to Vercel (per CLAUDE.md App Deploy Rule -- ask before pushing).
2. For Supabase Edge Functions or migrations, deploy explicitly via `npm run supabase:functions:deploy:all` and `supabase db push`. They do NOT auto-deploy on git push.
