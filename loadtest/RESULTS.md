# Load test results & verification checklist

## Scripts

| File | Purpose |
|------|---------|
| `read-storm.js` | Unauthenticated health/ready/metrics at 100/500/1000 VUs |
| `mixed.js` | Authenticated `/users/me` + `/jobs/active` (set `AUTH_TOKEN`) |

Install k6: https://k6.io/docs/get-started/installation/

```bash
k6 run -e VUS=100 -e DURATION=30s loadtest/read-storm.js
k6 run -e VUS=500 -e DURATION=60s loadtest/read-storm.js
k6 run -e VUS=1000 -e DURATION=90s loadtest/read-storm.js
k6 run -e VUS=100 -e AUTH_TOKEN=<jwt> loadtest/mixed.js
```

## Gates

- Read storm: p95 &lt; 300ms, error rate &lt; 1%
- Mixed: p95 &lt; 1s, error rate &lt; 1%
- While letter/PDF jobs are queued: API process must not OOM; `/health/ready` stays UP

## Local verification (this change set)

| Check | Status |
|-------|--------|
| `api` TypeScript (`tsc -p api`) | Pass |
| `pdf-frontend` TypeScript | Pass |
| k6 executed in CI/dev machine | **Pending** — k6 not installed on the agent host; run scripts above against staging/prod API after deploy |
| Metrics endpoint | `GET /api/health/metrics` (JSON or `?format=prometheus`) |
| Ready fail-closed | `GET /health/ready` → 503 when DB or Redis down |

## Production deploy notes

1. Apply `migrations/004_perf_hot_indexes.sql` (or rely on boot `ensureIndex`).
2. Set API `INLINE_LETTER_SIGN_WORKERS=false`.
3. Set worker `RUN_PRODUCT_WORKERS=true`.
4. Restart via updated `ecosystem.config.js` (API cluster ×2 + worker + webreports).
5. Confirm pool budget: API×2×15 + worker×15 + webreports×5 ≈ 50 ≪ MySQL `max_connections`.
6. Run k6 read-storm at 100 → 500 → 1000 and paste summaries into this file.
