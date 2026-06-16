# Security & Maintenance

This file is the operational handbook for keeping WoodCutter Dashboard secure over time.
It's a checklist, not a manifesto — one section per recurring task.

## Threat model

The dashboard handles revenue data and holds API keys for Stripe/Odoo/Viva. Our concerns,
in order:

1. **Stolen API keys** → attacker can read transaction history, possibly issue refunds.
2. **Account takeover** (someone logs in as a legitimate user) → reads revenue, no writes.
3. **Cache poisoning / data corruption** → wrong numbers shown, no data loss.
4. **DoS** → dashboard temporarily unavailable, no data loss.

We are NOT defending against:
- A nation-state with persistent access to the user's laptop.
- Compromise of Cloudflare itself.
- Compromise of Stripe/Odoo/Viva themselves.

## Defence layers (what's already in place)

| Layer | What it does |
|---|---|
| Cloudflare Access (Google SSO) | Edge-level gate — non-allowlisted emails can't reach the app |
| Worker JWT validation | Defence-in-depth: signature + iss + aud + exp + alg checked on every request, even if Access is misconfigured |
| Shooters venue check | Server-side 403 if requested venue is `Shooters Brussels` and email is not in `SHOOTERS_ALLOWLIST`. The dashboard hides the menu, but a tampered client can't bypass |
| KV cache key validation | `assertSafeKvKey` — user input cannot enter cache keys (no poisoning) |
| Secret scrubbing | All log lines pass through a regex-based scrubber that strips `sk_live_…`, `Bearer …`, `?key=…` patterns |
| `workers_dev = false` | Both Workers have NO public URL. refresh is cron-only; api is reachable only via the dashboard route binding |
| Restricted Stripe Keys | Only `rk_live_…` (read-only on Charges/PIs/Refunds/Balance/Terminal). Stolen key cannot issue refunds |
| Source maps off | `vite.config.js` sets `sourcemap: false` — no client-side code map shipped to production |
| CSP + security headers | `_headers` file + Worker response headers — XSS-restrictive CSP, frame-ancestors deny, nosniff, no-referrer |
| Per-request CORS | `Access-Control-Allow-Origin` only echoed for explicitly allowed origins |
| TTLs on raw KV slices | 7-day TTL on source-level KV slices — limits how long stale data lingers |

## Key rotation cadence

Every **90 days**, rotate every API key:

1. Generate new key in the source (Stripe/Odoo/Viva/Supermetrics dashboard)
2. `wrangler secret put STRIPE_KEY_<NAME>` — paste the new value
3. Verify next cron run succeeds (manual trigger, watch logs)
4. Revoke the old key in the source dashboard

Set a calendar reminder. Don't skip — long-lived credentials accumulate exposure linearly.

**Immediate rotation is required if:**
- Key was pasted into a chat / screenshot / email (intentionally or not)
- A laptop with `.dev.vars` is lost or stolen
- A team member leaves
- Any Cloudflare Worker logs are shared externally

## Adding a new operator

1. **Cloudflare Zero Trust** → Access → Applications → WoodCutter Dashboard → Policies → Edit "Operators"
2. Add their email to the Include list
3. Save — takes effect on their next login

To grant Shooters Brussels access:
1. Edit `SHOOTERS_ALLOWLIST` in `workers/api/wrangler.toml` `[vars]` section
2. `cd workers/api && wrangler deploy`

## Removing an operator

1. Cloudflare Zero Trust → Applications → WoodCutter Dashboard → Policies → remove their email
2. (Optional but recommended) Cloudflare Zero Trust → My Team → Users → revoke active sessions

If they had Shooters access: also remove from `SHOOTERS_ALLOWLIST` and redeploy api Worker.

## Bumping the cache version

If a breaking change to the response shape ships (rare):

1. In `packages/shared/src/index.ts`, change `KV_VERSION = "v1"` → `"v2"`
2. Deploy refresh + api Workers together
3. Manually trigger refresh cron to populate new keys
4. Old `v1:*` keys orphan in KV — they expire in 7 days or you can `wrangler kv:key delete` them manually

## Dependency audit (monthly)

```bash
pnpm audit
pnpm outdated
```

Action threshold:
- Any **high** or **critical** advisory → fix within a week
- Any **moderate** → fix within a month
- Any direct dependency >1 major version behind → upgrade-and-test next maintenance window

Watch list: `stripe`, `fast-xml-parser`, `react`, `recharts`. These have the most blast radius.

## Monitoring

- **Daily:** Cloudflare Workers dashboard → `woodcutter-refresh` → Logs. Look for `[refresh] daily run` entries and any `FATAL` lines.
- **Per-incident:** dashboard footer shows per-source freshness. Yellow/red dots = a source is stale. Click = detail.
- **/api/health** is unauth-callable — set up a synthetic monitor (UptimeRobot, BetterUptime free tier) hitting it every 5 min. Returns `status: "ok"` when all sources fresh.

## Incident playbook — suspected key compromise

1. **Revoke the key immediately** in Stripe/Odoo/Viva dashboard. The Worker will start failing for that source.
2. **Generate a new key.**
3. **Update the Worker secret.** `wrangler secret put STRIPE_KEY_<NAME>`.
4. **Trigger the cron manually** to verify recovery.
5. **Rotate ALL keys, not just the suspected one.** Compromise is usually broader than the visible signal.
6. **Audit access logs** (Cloudflare Zero Trust → Logs → Access). Look for unfamiliar emails or unusual login patterns.

## Incident playbook — suspected unauthorized dashboard access

1. **Cloudflare Zero Trust → My Team → Revoke all sessions** (forces everyone to re-login).
2. **Tighten allowlist.** Remove anyone whose email is shared/compromised.
3. **Bump `CF_ACCESS_AUD`** by recreating the Access application — this invalidates all existing JWTs.
4. **Audit Cloudflare Zero Trust logs** for unauthorized login attempts.
5. **Check Worker logs** for any 200 responses to suspect emails on non-public endpoints.

## Files that must NEVER be committed

- `**/.dev.vars` (gitignored)
- Any `.json` containing credentials (gitignored: `*.json.secret`)
- `wrangler.toml` with real KV namespace IDs is OK — IDs aren't secrets, they just identify a namespace within YOUR account

## Code review checklist for future changes

When reviewing a PR that touches the workers, ask:
- Does any new `console.log` go through `scrub()` or `log()`?
- Does any new endpoint require JWT validation? (Pattern: handler called from `default.fetch` after `validateAccessJwt`.)
- Does any new KV write call `assertSafeKvKey`?
- Does any new env var get added to `Env` interface AND `wrangler.toml` AND `SECURITY.md`'s rotation list (if it's a secret)?
- Does any new dependency have an active maintainer?
