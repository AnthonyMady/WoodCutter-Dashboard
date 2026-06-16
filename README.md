# WoodCutter Dashboard

Cloudflare-hosted revenue + marketing dashboard. Replaces the legacy CSV → email → Drive pipeline with: Cron Worker → KV → API Worker → React.

```
Cloudflare Cron → workers/refresh → APIs (Stripe/Odoo/Viva/Supermetrics) → KV
                                                                              ↓
       user (Cloudflare Access · Google SSO) → workers/api → KV ←─────────────┘
                                                  ↓
                                        apps/web (React+Vite+recharts)
```

## Repo layout

```
woodcutter-dashboard/
├─ apps/web/                # Vite + React + recharts (Cloudflare Pages)
├─ workers/api/             # GET /api/*  (KV reads only, JWT-validated)
├─ workers/refresh/         # Cron — calls upstream APIs, writes KV
├─ packages/shared/         # Types, VAT, targets, ISO, Belgium split
└─ pnpm-workspace.yaml
```

`@woodcutter/shared` is imported by both Worker and dashboard — single source of truth for VAT divisors, annual targets, the Belgium → Brussels/Anvers split rule, and all data shapes.

## Local dev

```bash
node --version    # need ≥ 20
corepack enable
pnpm install
pnpm typecheck
```

Then in three terminals:

```bash
cd workers/refresh && pnpm dev   # :8788
cd workers/api     && pnpm dev   # :8787
cd apps/web        && pnpm dev   # :5173 (proxies /api → :8787)
```

For local secrets, create `workers/refresh/.dev.vars` (gitignored):

```
STRIPE_KEY_BRUSSELS=sk_test_...
ODOO_URL=https://woodcutter.odoo.com
ODOO_DB=woodcutter
ODOO_USER=operations@woodcutter.be
```

You don't need every key — the Worker skips sources it lacks credentials for and surfaces them as `partial`.

## Cloudflare deploy

### 1. Prereqs

- Cloudflare account (free tier covers it)
- A domain on Cloudflare DNS for Cloudflare Access — can't gate `*.github.io`
- `pnpm i -g wrangler && wrangler login`

### 2. Create KV namespace

```bash
wrangler kv:namespace create woodcutter
# Paste the returned id into BOTH:
#   workers/api/wrangler.toml
#   workers/refresh/wrangler.toml
```

### 3. Set secrets on the refresh Worker

```bash
cd workers/refresh

# Stripe (8 venues — use Restricted Keys, see "Security" below)
for v in BRUSSELS BERLIN FRANKFURT HAMBURG BONN KOLN LEIPZIG SHOOTERS_BRUSSELS; do
  wrangler secret put STRIPE_KEY_$v
done

# Odoo (6 venues)
for v in BELGIUM BERLIN FRANKFURT HAMBURG KOLN LEIPZIG; do
  wrangler secret put ODOO_KEY_$v
done

# Viva
wrangler secret put VIVAWALLET_MERCHANT_ID
wrangler secret put VIVAWALLET_KEY
wrangler secret put VIVA_CITY_MAP    # optional JSON: {"VWA":"Anvers"}

# Supermetrics
wrangler secret put SUPERMETRICS_API_KEY
wrangler secret put META_ADS_USER_ID    # optional

# Plain vars (set if non-default)
wrangler secret put GOOGLE_ADS_ACCOUNT_IDS    # comma-separated
wrangler secret put META_ADS_ACCOUNT_IDS      # comma-separated, "act_" prefix added if missing
```

### 4. Set secrets on the api Worker

```bash
cd workers/api
wrangler secret put CF_ACCESS_AUD          # AUD tag from Zero Trust app
wrangler secret put CF_ACCESS_TEAM_DOMAIN  # e.g. "woodcutter"
```

### 5. Deploy

```bash
pnpm deploy:refresh
pnpm deploy:api
# Pages: connect repo on Cloudflare dashboard. Build command: `pnpm --filter web build`. Output: `apps/web/dist`
```

### 6. Configure Cloudflare Access

1. Cloudflare → Zero Trust → enable Google as identity provider
2. Access → Applications → Add Self-hosted, covering `dashboard.<domain>` AND `*/api/*`
3. Policy: allowlist of emails
4. Copy the AUD tag → `wrangler secret put CF_ACCESS_AUD`

### 7. Verify

Manually trigger the refresh cron from the Cloudflare dashboard so KV gets populated. Then open the dashboard URL.

## Security obligations

These are real items — do them in parallel with deploy or before cutover.

1. **Stripe Restricted Keys, not full secret keys.** Switch to `rk_live_…` with read-only permissions on Charges, PaymentIntents, Refunds, BalanceTransactions, Terminal.Reader. Stolen restricted keys can't issue refunds or modify products.
2. **Rotate every Stripe + Odoo key at cutover.** They've passed through 12+ months of GitHub Actions logs and SMTP-attached CSV emails. Treat as compromised; rotation is free and resets the leak risk.
3. **Worker secret leakage surfaces.** Every `console.log` in `workers/refresh/src/index.ts` runs through `scrub()` which strips `sk_live_…`, `Bearer …`, and `?key=…` patterns. Don't bypass the scrubber.
4. **Source maps off in prod.** `apps/web/vite.config.js` sets `build.sourcemap: false`. Keep it that way.
5. **Defense-in-depth on auth.** The api Worker validates the Access JWT signature itself (signature + aud + exp). If Access is misconfigured at the edge ("Allow Everyone"), the Worker still rejects unauthenticated requests. The Shooters Brussels gating is also enforced server-side — a tampered client can't fetch the data.
6. **KV cache poisoning prevention.** All KV writes go through `assertSafeKvKey()` so user input can't leak into cache keys.
7. **Service-account JSON for Sheets is now obsolete.** Once Supermetrics moves into the Worker, delete the old service account from Google Cloud IAM, revoke its key, remove from Sheet sharing.
8. **The legacy `Poly-Exporter` repo and the legacy Apps Script.** After cutover: archive the repo, disable the Apps Script trigger, delete the Drive folder. The CSVs sitting in Gmail since the project began contain customer emails and card-holder names — mass-delete them at cutover.

## Operational notes

- **Cron schedule** (in `workers/refresh/wrangler.toml`):
  - `*/30 * * * *` — Stripe (every 30 min)
  - `7 * * * *`   — Odoo + Viva (every hour at :07)
  - `23 5 * * *`  — Supermetrics (daily ~06:23–07:23 Brussels)
- **Failure mode**: per-source failures don't kill the run. The Worker logs the error, leaves last-known-good in KV, and surfaces a stale-source banner in the dashboard footer.
- **Manual refresh**: trigger the cron via the Cloudflare dashboard ("Trigger now").
- **Health**: `GET /api/health` is unauthenticated by design (for synthetic monitors).

## Status

Code is written but not verified. Run `pnpm install` and `pnpm typecheck` to surface bugs; expect ~10–30 TypeScript errors on first run (mostly `noUncheckedIndexedAccess` complaints and Cloudflare-types annotations). Fix those, then `wrangler dev` each worker before deploying.
