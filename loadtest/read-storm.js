import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:5000';
const errorRate = new Rate('errors');
const readyMs = new Trend('ready_ms');
const metricsMs = new Trend('metrics_ms');

export const options = {
  vus: Number(__ENV.VUS || 100),
  duration: __ENV.DURATION || '60s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300'],
    errors: ['rate<0.01'],
  },
};

export default function () {
  const live = http.get(`${BASE}/health/live`);
  check(live, { 'live 200': (r) => r.status === 200 }) || errorRate.add(1);

  const t0 = Date.now();
  const ready = http.get(`${BASE}/health/ready`);
  readyMs.add(Date.now() - t0);
  check(ready, { 'ready 200': (r) => r.status === 200 }) || errorRate.add(1);

  const t1 = Date.now();
  const metrics = http.get(`${BASE}/api/health/metrics`);
  metricsMs.add(Date.now() - t1);
  check(metrics, { 'metrics 200': (r) => r.status === 200 }) || errorRate.add(1);

  sleep(0.2);
}
