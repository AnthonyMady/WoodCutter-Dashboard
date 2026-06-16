# WoodCutter Dashboard

Cloudflare-hosted revenue + marketing dashboard, replacing the legacy CSV-via-Drive pipeline. Free tier, no domain required.

```
              ┌────────────────────────────────────────┐
              │ Cloudflare Cron (daily 05:13 UTC)      │
              └──────────────┬─────────────────────────┘
                             ▼
       ┌─────────────────────────────────────┐    Stripe (×9)
       │ workers/refresh                      │ ─► Odoo XML-RPC (×6)
       │ holds all secrets, fetches APIs     │ ─► Viva Wallet
       │ writes pre-computed JSON to KV      │ ─► Supermetrics
       └──────────────┬──────────────────────┘
                      ▼
                 ┌────────┐
                 │   KV   │
                 └────┬───┘
                      ▲
                      │ reads
                      │
   user ─Google SSO─► │ apps/web (Pages + Functions)
   (CF Access)        │   /         → React dashboard
                      │   /api/*    → Pages Function (validates JWT, reads KV)
                      └─────────────────────
```

**One Cloudflare account, one Pages project, one Worker. No domain needed.**

## Repo layout

```
WoodCutter-Dashboard/
├─ apps/web/                       # Cloudflare Pages project
│  ├─ src/                         # React + Vite + recharts dashboard
│  ├─ functions/api/               # Pages Functions (server-side)
│  │  ├─ [[path]].ts               # Routes /api/* (validates JWT, reads KV)
│  │  └─ _auth.ts                  # JWT validation helper
│  └─ public/_headers              # Security headers for static assets
├─ workers/refresh/                # Standalone Worker — cron only, no public URL
│  └─ src/sources/{stripe,odoo,viva,supermetrics,xmlrpc}.ts
├─ packages/shared/                # Types + business logic shared by both
└─ pnpm-workspace.yaml
```

`@woodcutter/shared` = single source of truth for VAT divisors, annual targets, the Belgium → Brussels/Anvers split rule, and all data shapes.

---

# Setup walkthrough

Total time: ~1.5 hours. Stop between phases — they're independent checkpoints.

## Phase 1 — Save your code (15 min)

```bash
cd /path/to/WoodCutter-Dashboard

# Verify the code still works
pnpm install
pnpm typecheck
pnpm test

# Commit and push
git add .
git commit -m "scaffold cloudflare rewrite"
git push --set-upstream origin cf-rewrite
```

If you hit `403 Permission denied`: either ask Anthony to add `LamaKey` as a Write collaborator on his repo, or fork to your own account first (`gh repo fork` or via github.com).

✅ **Checkpoint 1: code is durable on GitHub.**

---

## Phase 2 — Cloudflare account (5 min)

1. Sign up at [https://dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) — Free plan
2. Verify email
3. **Enable 2FA** on your Cloudflare account: My Profile → Authentication. This account holds all your secrets — protect it harder than Stripe.
4. Install wrangler:
   ```bash
   pnpm add -g wrangler
   wrangler login   # opens browser for OAuth
   wrangler whoami  # confirms it worked
   ```

✅ **Checkpoint 2: Cloudflare account ready, CLI authenticated.**

---

## Phase 3 — Create KV (5 min)

```bash
cd /path/to/WoodCutter-Dashboard
wrangler kv:namespace create woodcutter
```

Output looks like:
```
Add the following to your wrangler.toml:
[[kv_namespaces]]
binding = "KV"
id = "abc123def456..."
```

**Copy the `id` value.** You'll paste it in two places.

Open `workers/refresh/wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "KV"
id = "REPLACE_WITH_KV_NAMESPACE_ID"   ← paste your real id here
```

Save the id somewhere — you'll also paste it into Pages settings (Phase 5).

✅ **Checkpoint 3: KV namespace exists.**

---

## Phase 4 — Set secrets + deploy refresh Worker (20 min)

This is the longest phase — pasting credentials.

### 4.1 Get your secret values

Two options:
- **Reuse existing keys** from your Poly-Exporter GitHub Actions secrets (faster)
- **Generate fresh keys** (more secure, recommended for production)

For Stripe: **use Restricted Keys** (`rk_live_…`), not full secret keys:
1. Stripe Dashboard → switch to each location's account
2. Developers → API keys → "Create restricted key"
3. Permissions: **Read** access only on Charges, PaymentIntents, Refunds, Balance Transactions, Terminal.Reader

### 4.2 Set the secrets

```bash
cd workers/refresh

# Stripe (8 keys)
wrangler secret put STRIPE_KEY_BRUSSELS
wrangler secret put STRIPE_KEY_BERLIN
wrangler secret put STRIPE_KEY_FRANKFURT
wrangler secret put STRIPE_KEY_HAMBURG
wrangler secret put STRIPE_KEY_BONN
wrangler secret put STRIPE_KEY_KOLN
wrangler secret put STRIPE_KEY_LEIPZIG
wrangler secret put STRIPE_KEY_SHOOTERS_BRUSSELS

# Odoo (6 keys)
wrangler secret put ODOO_KEY_BELGIUM
wrangler secret put ODOO_KEY_BERLIN
wrangler secret put ODOO_KEY_FRANKFURT
wrangler secret put ODOO_KEY_HAMBURG
wrangler secret put ODOO_KEY_KOLN
wrangler secret put ODOO_KEY_LEIPZIG

# Viva
wrangler secret put VIVAWALLET_MERCHANT_ID
wrangler secret put VIVAWALLET_KEY

# Supermetrics
wrangler secret put SUPERMETRICS_API_KEY
wrangler secret put GOOGLE_ADS_ACCOUNT_IDS    # comma-separated
wrangler secret put META_ADS_ACCOUNT_IDS      # comma-separated

# Verify all are set
wrangler secret list
```

### 4.3 Deploy

```bash
wrangler deploy
```

Output: `Published woodcutter-refresh`. No public URL because `workers_dev = false` (intentional).

✅ **Checkpoint 4: refresh Worker is deployed and will fire daily at 05:13 UTC.**

---

## Phase 5 — Cloudflare Pages (15 min)

This is where the dashboard goes.

### 5.1 Connect repo to Pages

Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** tab → **Connect to Git**.

- Authorize Cloudflare to access your GitHub
- Select repo: `WoodCutter-Dashboard`
- Production branch: `cf-rewrite`

### 5.2 Build settings

| Field | Value |
|---|---|
| Framework preset | None |
| Build command | `pnpm install --frozen-lockfile=false && pnpm --filter web build` |
| Build output directory | `apps/web/dist` |
| Root directory | (leave blank) |
| Environment variable | `NODE_VERSION` = `20` |

Click **Save and Deploy**. Wait ~2-3 min.

After successful build, Cloudflare gives you a URL like:
**`https://woodcutter-dashboard.pages.dev`**

Open it — the React app loads but shows errors (no data yet, no auth yet — both expected).

### 5.3 Bind KV to Pages Functions

Pages → your project → **Settings** → **Functions** → **KV namespace bindings** → **Add binding**:

| Field | Value |
|---|---|
| Variable name | `KV` |
| KV namespace | (select `woodcutter` from dropdown) |

Click Save.

### 5.4 Add Pages env vars (placeholder values for now)

Pages → **Settings** → **Environment variables**.

For **Production** environment, add:

| Variable | Type | Value |
|---|---|---|
| `SHOOTERS_ALLOWLIST` | Plaintext | `anthony.mady.work@gmail.com,romain2felix@gmail.com,julien.vandenitte.work@gmail.com` |
| `CF_ACCESS_AUD` | Encrypted | (placeholder — set after Phase 6) |
| `CF_ACCESS_TEAM_DOMAIN` | Encrypted | (placeholder — set after Phase 6) |

Don't worry about values for the AUD/TEAM_DOMAIN yet — we set them in Phase 6.

### 5.5 Redeploy to pick up bindings

Pages → **Deployments** → on the latest deployment → **Retry deployment**. Wait 2 min.

✅ **Checkpoint 5: dashboard URL is live, KV bound, env vars wired.**

---

## Phase 6 — Cloudflare Access (Google SSO) (15 min)

### 6.1 Open Zero Trust

Cloudflare dashboard → left sidebar → **Zero Trust**.

First time: pick a team name (e.g. `woodcutter`) → free plan.

**Save your team domain prefix** (e.g. `woodcutter`). You'll need it in step 6.5.

### 6.2 Add Google as identity provider

Zero Trust → **Settings** → **Authentication** → **Login methods** → **Add new** → **Google**.

Cloudflare walks you through creating an OAuth client in Google Cloud Console:
1. Open Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID → Web application
2. Cloudflare gives you an authorized redirect URI to paste into Google
3. Google gives you a Client ID + Client Secret
4. Paste those back into Cloudflare → Save

### 6.3 Create the Access application

Zero Trust → **Access** → **Applications** → **Add an application** → **Self-hosted**.

| Field | Value |
|---|---|
| Application name | WoodCutter Dashboard |
| Session duration | 24 hours (or shorter for tighter security) |
| Application domain | `woodcutter-dashboard.pages.dev` |
| Identity providers | ☑ Google |

Click **Next**.

**IMPORTANT — copy the AUD tag** that appears (looks like `5a7e8b4f...`).

### 6.4 Set the access policy

Same flow → **Policies** tab → **Add a policy**:

- **Policy name:** Operators
- **Action:** Allow
- **Configure rules → Include:**

For your team's company emails (if applicable):
- Selector: **Emails ending in**
- Value: `@woodcutter.de` (or your team domain)

For specific people:
- Add another rule → Selector: **Emails**
- Values: `anthony.mady.work@gmail.com`, etc.

Save policy → Save application.

### 6.5 Set the Pages env vars (the real values)

Cloudflare → **Workers & Pages** → your Pages project → **Settings** → **Environment variables**.

Edit:
- `CF_ACCESS_AUD` → paste the AUD tag from step 6.3 (Encrypted)
- `CF_ACCESS_TEAM_DOMAIN` → paste your team prefix (e.g. just `woodcutter`, NOT the full URL) (Encrypted)

### 5.6 Redeploy

Pages → **Deployments** → latest deployment → **Retry deployment**.

✅ **Checkpoint 6: Access protects the dashboard, Pages Functions can validate JWTs.**

---

## Phase 7 — First test (5 min)

### 7.1 Trigger the cron manually

Cron only fires daily at 05:13 UTC. To populate KV right now:

Cloudflare dashboard → **Workers & Pages** → `woodcutter-refresh` → **Triggers** tab → **Cron Triggers** → click **"Trigger Cron"**.

Watch the **Logs** tab. Within 30-60 seconds you should see:
```
[refresh] daily run at=...
[refresh] stripe ok=8 err=0
[refresh] odoo pos=6 inv=6 err=0
[refresh] viva rows=N
[refresh] supermetrics google=N meta=N
[refresh] aggregated 10 venues + digest
```

### 7.2 Open the dashboard

Open `https://woodcutter-dashboard.pages.dev` in a fresh browser tab.

Expected:
1. Redirect to Google login screen
2. Log in with an allowlisted email
3. Redirect back to the dashboard
4. Real KPIs and charts render

### 7.3 Sanity check

```bash
curl https://woodcutter-dashboard.pages.dev/api/health
# Should return: {"status":"ok"}
```

(For unauthenticated `/api/health` you only get the overall status — no upstream details. That's intentional.)

✅ **Checkpoint 7: 🎉 fully working dashboard.**

---

## Phase 8 — Hardening checklist (do over the next week)

- [ ] Set up an uptime monitor (UptimeRobot free tier hits `/api/health` every 5 min)
- [ ] **Rotate every Stripe + Odoo key** that you copied from the old system
- [ ] Calendar reminder: rotate keys every 90 days
- [ ] Lower Access session duration to 4-8 hours if comfortable
- [ ] Run `pnpm audit` monthly
- [ ] After running new + old in parallel for a week and confirming numbers match: decommission `Poly-Exporter` (disable GitHub Actions cron, delete Apps Script trigger, delete Drive folder)

See `SECURITY.md` for incident playbooks and rotation procedures.

---

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| Pages build fails: "command not found: pnpm" | Node version too old | `NODE_VERSION=20` env var in Pages settings |
| Dashboard shows "no cached data" | Cron hasn't run | Manual trigger (Phase 7.1) |
| `403 forbidden` from `/api/*` | AUD or team domain wrong | Re-paste both env vars exactly — no whitespace, no quotes |
| Stuck on Google login loop | Email not in Access policy | Add it (Phase 6.4) |
| KV reads return null | Binding name doesn't match `KV` | Phase 5.3 — variable name must be exactly `KV` |
| `[[path]].ts` not picked up | File-based routing typo | Filename must literally be `[[path]].ts` (double brackets) |

---

## Order at a glance

```
[1] Save code on GitHub
[2] Cloudflare account + wrangler login
[3] Create KV namespace
[4] Set 19 secrets + deploy refresh Worker
[5] Pages: connect repo, build, bind KV, set env vars (placeholders)
[6] Cloudflare Access: Google IdP, app, policy, AUD → fill the placeholders
[7] Trigger cron + open dashboard 🎉
[8] Hardening over time
```
