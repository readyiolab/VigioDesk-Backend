import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:5000';
const TOKEN = __ENV.AUTH_TOKEN || '';
const errorRate = new Rate('errors');

export const options = {
  vus: Number(__ENV.VUS || 100),
  duration: __ENV.DURATION || '60s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
    errors: ['rate<0.01'],
  },
};

function authHeaders() {
  const h = { Accept: 'application/json' };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

export default function () {
  const ready = http.get(`${BASE}/health/ready`);
  check(ready, { ready: (r) => r.status === 200 }) || errorRate.add(1);

  if (!TOKEN) {
    sleep(0.3);
    return;
  }

  const me = http.get(`${BASE}/api/users/me`, { headers: authHeaders() });
  check(me, { 'me 200': (r) => r.status === 200 }) || errorRate.add(1);

  const jobs = http.get(`${BASE}/api/jobs/active`, { headers: authHeaders() });
  check(jobs, { 'active jobs 200': (r) => r.status === 200 || r.status === 404 }) || errorRate.add(1);

  sleep(0.25);
}
