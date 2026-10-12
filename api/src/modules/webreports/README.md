# Readyio WebReports

Website audits for signed-in, verified accounts. The API validates the URL, stores a queued report, and enqueues a BullMQ job. A separate worker crawls the site, runs SEO and AI-search checks, measures mobile and desktop performance, scores the result, and writes it back. The React app polls the report until it finishes.

The API process never crawls and never runs Lighthouse.

## Layout

| Path | Role |
| --- | --- |
| `backend/shared/webreports/` | Canonical URLs, SSRF checks, scoring, SEO and AI-search checks, recommendations, summary template, report contract |
| `backend/api/src/modules/webreports/` | Routes, Zod validation, quota and cache logic, serializers |
| `backend/api/src/lib/webreportSchema.ts` | Boot DDL |
| `backend/api/src/lib/webreportsQueue.ts` | Enqueue and remove waiting jobs |
| `backend/worker/src/webreports.worker.ts` | Process entry, recovery, health port |
| `backend/worker/src/webreports/` | Crawl, HTML parse, robots, browser proxy, Lighthouse, PSI, persistence |
| `frontend/src/features/webreports/` | Query hooks and dashboard |
| `frontend/src/pages/webreports/` | Scan form, report page, public share page |

## Dependencies

- API and worker: `ipaddr.js` for address classification.
- Worker only: `cheerio`, `robots-parser`, `lighthouse`, `@anthropic-ai/sdk`.
- Chromium is the Puppeteer install already used by the PDF worker. Playwright is not used. Lighthouse talks to that Chrome over CDP.
- HTTP fetches use Node `fetch` through a pinned lookup. They do not use a second HTTP client.

## Environment

Optional keys must be absent or empty without stopping boot. Redis and MySQL stay required, as they are for the rest of the API.

API (`backend/api/.env.example`):

- `PSI_API_KEY` — PageSpeed Insights and CrUX. When unset, field data is unavailable.
- `ANTHROPIC_API_KEY` — optional narrative. When unset or invalid, the report uses the template summary.
- `WEBREPORTS_MAX_PAGES` — global page ceiling, default 50.
- `WEBREPORTS_CACHE_TTL_MINUTES` — default 30.
- `WEBREPORTS_WEIGHT_MOBILE`, `WEBREPORTS_WEIGHT_DESKTOP`, `WEBREPORTS_WEIGHT_SEO`, `WEBREPORTS_WEIGHT_AI` — scoring overrides. Negative or all-zero weights fail worker startup. Any other set that does not sum to 100 is normalized and logged.

Worker (`backend/worker/.env.example`): `REDIS_URL` plus the worker settings below. The webreports process does not load the PDF worker's Spaces credentials.

| Setting | Default |
| --- | --- |
| `WEBREPORTS_HEALTH_PORT` | 5002 |
| `WEBREPORTS_CONCURRENCY` | 1 (maximum 4) |
| `WEBREPORTS_CRAWL_CONCURRENCY` | 3 (maximum 5) |
| `WEBREPORTS_POLITE_DELAY_MS` | 250 |
| `WEBREPORTS_SCAN_TIMEOUT_MS` | 600000 |
| `WEBREPORTS_PAGE_TIMEOUT_MS` | 20000 |
| `WEBREPORTS_MAX_BYTES` | 2097152 |
| `WEBREPORTS_LIGHTHOUSE_CONCURRENCY` | 1 |
| `WEBREPORTS_SUMMARY_TIMEOUT_MS` | 12000 |
| `WEBREPORTS_SUMMARY_MODEL` | `claude-sonnet-4-5` |
| `CHROME_PATH` | Puppeteer's bundled Chrome when unset |

## Database

Tables are created at API boot with `CREATE TABLE IF NOT EXISTS` inside `initializeDatabase`. There is no migration command and no down migration. Dropping `tbl_webreport`, `tbl_webreport_page`, `tbl_webreport_check`, and `tbl_webreport_perf` is a manual operation. Child rows cascade when a report is deleted. The report row cascades when its user is deleted.

`tbl_user` gains `dailyWebReportsUsed` and `dailyWebReportsResetAt` through `ensureColumn`.

IDs are UUID strings. Share tokens are 32 random bytes, hex-encoded, stored in plaintext, and unique. Revoke sets the token to `NULL` immediately.

## API

Mounted at `/api/webreports` and `/api/public/webreports`. Private routes require a full, verified account (`authMiddleware`, `requireFullAccount`, `requireVerifiedEmail`). A missing or unowned report is 404.

| Method | Path | Result |
| --- | --- | --- |
| `POST /api/webreports` | `{ url, maxPages?, force? }` | 202 `{ cached: false, report }` for new work. 200 `{ cached: true, report }` when the same user scanned that canonical URL in the cache window and `force` is false. |
| `GET /api/webreports?limit&offset` | history | `{ reports, pagination }` |
| `GET /api/webreports/:id` | one report | Polled by the UI. |
| `POST /api/webreports/:id/rescan` | new generation | Counts against the daily quota. 409 while that report is running. |
| `POST /api/webreports/:id/share` | token | `{ shareToken, sharePath }` |
| `DELETE /api/webreports/:id/share` | revoke | |
| `DELETE /api/webreports/:id` | delete | Removes a waiting or delayed job. A running worker stops writing when the row is gone. |
| `GET /api/public/webreports/:token` | public report | Allowlisted fields only. No user id, job id, or share token. A failed public report says `This shared scan did not complete.` |

Create is limited to 20 requests per hour per user. Polling is 120 per minute. The public route is 120 per 15 minutes.

Plan quotas, with no billing changes:

| Plan | Scans / 24h | Concurrent | Pages |
| --- | --- | --- | --- |
| FREE | 3 | 1 | 10 |
| PRO | 30 | 2 | 50 |
| ENTERPRISE | 100 | 3 | 50 |

`maxPages` cannot exceed the plan or `WEBREPORTS_MAX_PAGES`. The quota counter and the concurrent count update in the same transaction as the insert. If Redis rejects the job, the row is marked failed and the daily quota is refunded.

## Jobs

Queue name: `webreports`. Job id: `{reportId}:{jobGeneration}`. Attempts: 2, exponential backoff 15 seconds.

On startup, and every 120 seconds, the worker re-queues `queued` rows that have no live job and fails `running` rows whose deadline has passed. The worker writes only when `activeJobId` and `jobGeneration` still match and the status is `queued` or `running`. Progress reaches 100 only after the completed transaction commits.

Bull Board lists this queue next to the PDF queues.

## Scoring

Version `webreports-scoring-v1`. Default weights: mobile 30, desktop 15, SEO 30, AI search 25.

A category score starts at 100. Present findings deduct 20 (critical), 10 (warning), or 4 (info). Duplicate check ids are ignored. A category with only unavailable or inconclusive checks is `null`, not 0 or 100. The overall score renormalizes across categories that have a number. Completeness lists the missing categories. Field data is recorded separately; a missing CrUX sample adds `field-data` and marks the report incomplete. Lab TBT is never stored as INP. INP comes only from CrUX. Scores use half-away-from-zero rounding and stay in 0–100.

At most six recommendations are stored, ranked by impact, severity and scope, then easier effort, then confidence, then stable id.

## SSRF

Only `http:` and `https:` are allowed. Userinfo, unsupported numeric hosts, loopback, private, link-local, multicast, reserved, unspecified, CGNAT, IPv4-mapped IPv6, and cloud metadata hosts are rejected. Every A and AAAA answer is checked. Node fetch pins DNS `lookup` to a validated address and sets TLS `servername` to the original hostname. Each redirect is revalidated, with a maximum of five. The client sends `User-Agent: ReadyioBot` and does not forward cookies or authorization.

Chromium is launched with `--proxy-server` pointed at an in-process proxy. That proxy connects only to a validated address. Puppeteer request interception is a second blocklist. Interception alone is not sufficient.

The droplet firewall should deny egress to RFC1918, link-local, and metadata addresses, for example:

```
ufw deny out to 10.0.0.0/8
ufw deny out to 172.16.0.0/12
ufw deny out to 192.168.0.0/16
ufw deny out to 169.254.0.0/16
ufw deny out to 100.64.0.0/10
```

This repository does not apply those rules.

Crawl scope is the same scheme, host, and effective port. `robots.txt` is honored for ReadyioBot and recorded for GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot, Claude-Web, PerplexityBot, Google-Extended, and CCBot. Sitemap recursion is depth 3 and at most 100 URLs. Timeouts are inconclusive, not broken links.

## Frontend

Routes:

- `/webreports` — signed-in, verified. Submit and history.
- `/webreports/:id` — progress and dashboard. Polls `GET /api/webreports/:id` about every 2 seconds, pauses while the tab is hidden, and stops on `completed` or `failed`.
- `/webreports/shared/:token` — public, read-only, no owner actions.

Crawled strings are rendered as text. The dashboard does not inject HTML.

Nginx does not need a change. Progress uses short JSON polls, not the PDF job SSE stream.

## Process

Build the worker, then start only this app:

```
npm --workspace=worker run build
pm2 start ecosystem.config.js --only pdf-saas-webreports
```

PM2 name: `pdf-saas-webreports`. Script: `dist/worker/src/webreports.worker.js` with cwd `backend/worker` (production cwd `/var/www/pdf/pdf-backend/worker`). `max_memory_restart` is `1500M`. Health: `GET http://127.0.0.1:5002/health`.

On SIGTERM or SIGINT the worker stops taking jobs, aborts in-flight scans, closes Chrome and the proxy, then closes Redis and MySQL.

## Tests

```
npm --workspace=api test
npm --workspace=worker test
npm --prefix frontend test
```

API tests are `node:test` via `tsx --test` and are listed in `backend/api/package.json`. They cover canonicalization, SSRF classification, pinned fetch, scoring, SEO and AI-search checks, crawler scope, and the service with an in-memory repository. `WEBREPORTS_INTEGRATION=1` also creates the tables against the configured MySQL database. That test is skipped otherwise.

Worker tests cover HTML parsing and robots evaluation. They do not launch Chrome.

Frontend tests use Vitest and Testing Library with a mocked API. They cover empty history, validation, submit success and failure, progress, completed, partial, failed, public read-only, share, revoke, and rescan.

## Limitations

- CI does not call live sites, Chrome, PageSpeed, or Anthropic. A missing PSI or Anthropic key degrades to unavailable field data and a template summary.
- Browser request interception is not the SSRF boundary. The proxy and host firewall are.
- MySQL version is whatever the existing API uses. It is not pinned in this module.
- Guests and unverified accounts cannot scan.
