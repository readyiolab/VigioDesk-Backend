import type { AuditCheck, DevicePerformance, Recommendation } from './types';

const IMPACT_RANK = { high: 0, medium: 1, low: 2 };
const SEVERITY_RANK = { critical: 0, warning: 1, info: 2, pass: 3 };
const EFFORT_RANK = { easy: 0, medium: 1, hard: 2 };

const SNIPPETS: Record<string, string> = {
  'ai-bot-access': `User-agent: GPTBot\nAllow: /\n\nUser-agent: OAI-SearchBot\nAllow: /`,
  'missing-titles': `<title>Specific page title</title>`,
  'canonical-missing': `<link rel="canonical" href="https://example.com/page">`,
  'insecure-canonical': `<link rel="canonical" href="https://example.com/page">`,
  'missing-viewport': `<meta name="viewport" content="width=device-width, initial-scale=1">`,
  'ai-structured-data': `{\n  "@context": "https://schema.org",\n  "@type": "Organization",\n  "name": "Example",\n  "url": "https://example.com"\n}`,
  'js-render-dependency': `Render the primary text in the initial HTML, or prerender the route.`,
  'image-alt': `<img src="/photo.webp" alt="Team reviewing the audit" width="800" height="450" loading="lazy">`,
  'perf-images': `<img src="/hero.webp" alt="Product photo" width="1200" height="630" loading="eager">`,
  'perf-javascript': `<script src="/app.js" defer></script>`,
  'perf-cache': `location ~* \\.(?:css|js|webp|avif|woff2)$ {\n  add_header Cache-Control "public, max-age=31536000, immutable";\n}`,
  https: `return 301 https://$host$request_uri;`,
};

export function buildRecommendations(
  checks: AuditCheck[],
  performance: { mobile: DevicePerformance; desktop: DevicePerformance }
): Recommendation[] {
  const candidates = checks.filter((check) => check.status === 'present');
  const merged = dedupe([...candidates, ...performanceRecommendations(performance)]);
  merged.sort((a, b) => {
    const impact = IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact];
    if (impact) return impact;
    const severity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (severity) return severity;
    if (b.affectedCount !== a.affectedCount) return b.affectedCount - a.affectedCount;
    const effort = EFFORT_RANK[a.effort] - EFFORT_RANK[b.effort];
    if (effort) return effort;
    return a.id < b.id ? -1 : 1;
  });
  return merged.slice(0, 6).map((check, index) => ({
    rank: index + 1,
    title: check.title,
    impact: check.impact,
    effort: check.effort,
    why: check.description,
    scope: scopeLine(check),
    instructions: check.fix,
    snippet: SNIPPETS[check.id],
    checkIds: [check.id],
  }));
}

function scopeLine(check: AuditCheck): string {
  if (!check.affectedCount) return 'Sitewide sample';
  const sample = check.affectedUrls.slice(0, 3).join(', ');
  return `${check.affectedCount} affected${sample ? `: ${sample}` : ''}`;
}

function dedupe(checks: AuditCheck[]): AuditCheck[] {
  const byKey = new Map<string, AuditCheck>();
  for (const check of checks) {
    const key = check.dedupeKey || check.id;
    const existing = byKey.get(key);
    if (!existing || rank(check) < rank(existing)) byKey.set(key, check);
  }
  return [...byKey.values()];
}

function rank(check: AuditCheck): number {
  return IMPACT_RANK[check.impact] * 100 + SEVERITY_RANK[check.severity] * 10 + EFFORT_RANK[check.effort];
}

function performanceRecommendations(performance: {
  mobile: DevicePerformance;
  desktop: DevicePerformance;
}): AuditCheck[] {
  const out: AuditCheck[] = [];
  const mobile = performance.mobile;
  if (mobile.lcp !== null && mobile.lcp > 2500) {
    out.push({
      id: 'perf-lcp-mobile',
      category: 'performance',
      status: 'present',
      severity: mobile.lcp > 4000 ? 'critical' : 'warning',
      title: 'Improve mobile Largest Contentful Paint',
      description: `Lab LCP on mobile is ${Math.round(mobile.lcp)} ms.`,
      affectedCount: 1,
      affectedUrls: mobile.pageUrl ? [mobile.pageUrl] : [],
      fix: 'Compress the LCP image and avoid render-blocking CSS or JavaScript in front of it.',
      impact: 'high',
      effort: 'medium',
      dedupeKey: 'lcp',
    });
  }
  const cacheIssue = [...mobile.issues, ...performance.desktop.issues].find((issue) =>
    /cache/i.test(`${issue.id} ${issue.title}`)
  );
  if (cacheIssue) {
    out.push({
      id: 'perf-cache',
      category: 'performance',
      status: 'present',
      severity: 'warning',
      title: 'Cache static assets',
      description: cacheIssue.title,
      affectedCount: 1,
      affectedUrls: mobile.pageUrl ? [mobile.pageUrl] : [],
      fix: 'Send a long Cache-Control lifetime for fingerprinted assets.',
      impact: 'medium',
      effort: 'easy',
    });
  }
  const imageIssue = mobile.issues.find((issue) => /image/i.test(`${issue.id} ${issue.title}`));
  if (imageIssue) {
    out.push({
      id: 'perf-images',
      category: 'performance',
      status: 'present',
      severity: 'warning',
      title: 'Serve smaller images',
      description: imageIssue.displayValue || imageIssue.title,
      affectedCount: 1,
      affectedUrls: mobile.pageUrl ? [mobile.pageUrl] : [],
      fix: 'Convert large photos to WebP or AVIF and set width, height, and srcset.',
      impact: 'high',
      effort: 'medium',
    });
  }
  const jsIssue = mobile.issues.find((issue) => /javascript|unused-javascript|bootup/i.test(issue.id));
  if (jsIssue) {
    out.push({
      id: 'perf-javascript',
      category: 'performance',
      status: 'present',
      severity: 'warning',
      title: 'Reduce unused JavaScript',
      description: jsIssue.displayValue || jsIssue.title,
      affectedCount: 1,
      affectedUrls: mobile.pageUrl ? [mobile.pageUrl] : [],
      fix: 'Defer non-critical scripts so the first screen does not wait on them.',
      impact: 'high',
      effort: 'hard',
    });
  }
  if (mobile.cls !== null && mobile.cls > 0.1) {
    out.push({
      id: 'perf-cls',
      category: 'performance',
      status: 'present',
      severity: mobile.cls > 0.25 ? 'critical' : 'warning',
      title: 'Reduce layout shift',
      description: `Lab CLS is ${mobile.cls}.`,
      affectedCount: 1,
      affectedUrls: mobile.pageUrl ? [mobile.pageUrl] : [],
      fix: 'Set width and height on images and reserve space for late content.',
      impact: 'high',
      effort: 'medium',
    });
  }
  return out;
}
