# Load tests (k6)

Targets ~100 / 500 / 1000 concurrent virtual users against lean API paths.

## Prerequisites

- [k6](https://k6.io/docs/get-started/installation/) installed
- API reachable (`BASE_URL`, default `http://localhost:5000`)
- For authenticated scenarios: set `AUTH_TOKEN` to a valid customer JWT (cookie session also works if you extend the script)

## Scenarios

```bash
# Read storm (health + metrics + ready) — no auth
k6 run -e VUS=100 -e DURATION=60s loadtest/read-storm.js
k6 run -e VUS=500 -e DURATION=60s loadtest/read-storm.js
k6 run -e VUS=1000 -e DURATION=90s loadtest/read-storm.js

# Mixed authenticated traffic
k6 run -e VUS=100 -e DURATION=60s -e AUTH_TOKEN=... loadtest/mixed.js
k6 run -e VUS=500 -e DURATION=60s -e AUTH_TOKEN=... loadtest/mixed.js
k6 run -e VUS=1000 -e DURATION=90s -e AUTH_TOKEN=... loadtest/mixed.js
```

## Gates (initial)

| Scenario | p95 | Error rate |
|----------|-----|------------|
| Read storm | &lt; 300ms | &lt; 1% |
| Mixed lean lists | &lt; 1s | &lt; 1% |

Record results under `loadtest/results/` (create locally; not committed).
