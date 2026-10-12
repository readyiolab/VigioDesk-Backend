import type { Browser } from 'puppeteer';
import type { DevicePerformance } from '../../../shared/webreports/types';
import { averageDevices, metricsFromLighthouse } from '../../../shared/webreports/lighthouseMetrics';
import { unwrapHostname } from '../../../shared/webreports/canonicalize';
import { isProhibitedAddress } from '../../../shared/webreports/urlSafety';
import ipaddr from 'ipaddr.js';
import { logger } from './runtime';

const mobileSettings = {
  extends: 'lighthouse:default',
  settings: {
    onlyCategories: ['performance'],
    formFactor: 'mobile' as const,
    screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false },
    throttlingMethod: 'simulate' as const,
    throttling: {
      rttMs: 150,
      throughputKbps: 1638.4,
      requestLatencyMs: 562.5,
      downloadThroughputKbps: 1474.56,
      uploadThroughputKbps: 675,
      cpuSlowdownMultiplier: 4,
    },
  },
};

const desktopSettings = {
  extends: 'lighthouse:default',
  settings: {
    onlyCategories: ['performance'],
    formFactor: 'desktop' as const,
    screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
    throttlingMethod: 'simulate' as const,
    throttling: {
      rttMs: 40,
      throughputKbps: 10240,
      requestLatencyMs: 0,
      downloadThroughputKbps: 0,
      uploadThroughputKbps: 0,
      cpuSlowdownMultiplier: 1,
    },
  },
};

let active = 0;
const waiters: Array<() => void> = [];

async function withLighthouseLock<T>(limit: number, fn: () => Promise<T>): Promise<T> {
  if (active >= limit) await new Promise<void>((resolve) => waiters.push(resolve));
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    waiters.shift()?.();
  }
}

export async function launchBrowser(proxyPort: number, executablePath?: string): Promise<Browser> {
  const puppeteer = await import('puppeteer');
  return puppeteer.default.launch({
    headless: true,
    executablePath,
    pipe: false,
    args: [
      `--proxy-server=http://127.0.0.1:${proxyPort}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
}

export async function renderedTextLength(browser: Browser, url: string, timeoutMs: number): Promise<number | null> {
  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      try {
        const host = unwrapHostname(new URL(request.url()).hostname);
        if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
          void request.abort();
          return;
        }
        if (ipaddr.isValid(host) && isProhibitedAddress(host)) {
          void request.abort();
          return;
        }
        void request.continue();
      } catch {
        void request.abort();
      }
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const text = await page.evaluate(() => document.body?.innerText || '');
    return text.replace(/\s+/g, ' ').trim().length;
  } catch (err) {
    logger.warn({ err, url }, 'Rendered text measurement failed');
    return null;
  } finally {
    await page.close().catch(() => undefined);
  }
}

export async function runLighthouse(
  browser: Browser,
  url: string,
  device: 'mobile' | 'desktop',
  limit: number
): Promise<DevicePerformance> {
  return withLighthouseLock(limit, async () => {
    const lighthouse = (await import('lighthouse')).default;
    const endpoint = new URL(browser.wsEndpoint());
    const port = Number(endpoint.port);
    if (!port) return metricsFromLighthouse(null, url);
    try {
      const runner = await lighthouse(url, {
        port,
        hostname: endpoint.hostname,
        output: 'json',
        logLevel: 'error',
        onlyCategories: ['performance'],
      }, device === 'mobile' ? mobileSettings : desktopSettings);
      return metricsFromLighthouse(runner?.lhr || null, url);
    } catch (err) {
      logger.warn({ err, url, device }, 'Lighthouse failed');
      return metricsFromLighthouse(null, url);
    }
  });
}

export async function runDeviceSet(
  browser: Browser,
  urls: string[],
  device: 'mobile' | 'desktop',
  limit: number,
  signal: AbortSignal
): Promise<DevicePerformance> {
  const results: DevicePerformance[] = [];
  for (const url of urls) {
    if (signal.aborted) break;
    results.push(await runLighthouse(browser, url, device, limit));
  }
  const measured = results.filter((result) => result.score !== null);
  if (!measured.length) return metricsFromLighthouse(null, urls[0] || '');
  return averageDevices(measured);
}
