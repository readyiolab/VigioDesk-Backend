import crypto from 'crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { db } from '../../lib/mysql';
import { redis } from '../../lib/redis';
import { env } from '../../config/env';
import { AppError } from '../../middleware/errorHandler.middleware';
import { decryptJson, encryptJson, isSecretBoxConfigured } from '../../lib/secretBox';
import { fetchWithTimeout } from '../../lib/httpFetch';

export type IntegrationProvider = 'google_analytics' | 'google_search_console' | 'backlinks';

type OAuthTokens = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
  scope?: string;
  [key: string]: unknown;
};

type BacklinkSecrets = {
  login: string;
  password: string;
  source: 'platform' | 'byo';
};

type StoredIntegration = {
  id: string;
  userId: string;
  provider: IntegrationProvider;
  status: string;
  accountEmail: string | null;
  propertyId: string | null;
  propertyLabel: string | null;
  encryptedSecrets: string;
  metaJson: string | null;
};

const OAUTH_STATE_TTL_SEC = 600;

const SCOPES: Record<'google_analytics' | 'google_search_console', string> = {
  google_analytics: 'https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/userinfo.email',
  google_search_console: 'https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/userinfo.email',
};

function oauthRedirectUri() {
  return `${String(env.APP_URL || '').replace(/\/$/, '')}/webreports/oauth/callback`;
}

function requireSecretBox() {
  if (!isSecretBoxConfigured()) {
    throw new AppError('Server is missing INFRA_CREDENTIALS_KEY — cannot store integration secrets.', 503);
  }
}

function mapRow(row: RowDataPacket): StoredIntegration {
  return {
    id: String(row.id),
    userId: String(row.userId),
    provider: String(row.provider) as IntegrationProvider,
    status: String(row.status),
    accountEmail: row.accountEmail ? String(row.accountEmail) : null,
    propertyId: row.propertyId ? String(row.propertyId) : null,
    propertyLabel: row.propertyLabel ? String(row.propertyLabel) : null,
    encryptedSecrets: String(row.encryptedSecrets),
    metaJson: row.metaJson ? String(row.metaJson) : null,
  };
}

async function getIntegration(userId: string, provider: IntegrationProvider): Promise<StoredIntegration | null> {
  const row = await db.query<RowDataPacket>(
    `SELECT id, userId, provider, status, accountEmail, propertyId, propertyLabel, encryptedSecrets, metaJson
       FROM tbl_webreport_integration WHERE userId = ? AND provider = ? LIMIT 1`,
    [userId, provider]
  );
  return row ? mapRow(row) : null;
}

async function upsertIntegration(input: {
  userId: string;
  provider: IntegrationProvider;
  accountEmail?: string | null;
  propertyId?: string | null;
  propertyLabel?: string | null;
  secrets: unknown;
  meta?: unknown;
}) {
  requireSecretBox();
  const existing = await getIntegration(input.userId, input.provider);
  const encrypted = encryptJson(input.secrets);
  const metaJson = input.meta ? JSON.stringify(input.meta) : null;
  if (existing) {
    await db.execute(
      `UPDATE tbl_webreport_integration
          SET status = 'connected', accountEmail = ?, propertyId = COALESCE(?, propertyId),
              propertyLabel = COALESCE(?, propertyLabel), encryptedSecrets = ?, metaJson = COALESCE(?, metaJson),
              updatedAt = CURRENT_TIMESTAMP(3)
        WHERE id = ?`,
      [
        input.accountEmail ?? existing.accountEmail,
        input.propertyId ?? null,
        input.propertyLabel ?? null,
        encrypted,
        metaJson,
        existing.id,
      ]
    );
    return existing.id;
  }
  const id = crypto.randomUUID();
  await db.execute(
    `INSERT INTO tbl_webreport_integration
      (id, userId, provider, status, accountEmail, propertyId, propertyLabel, encryptedSecrets, metaJson)
     VALUES (?, ?, ?, 'connected', ?, ?, ?, ?, ?)`,
    [
      id,
      input.userId,
      input.provider,
      input.accountEmail ?? null,
      input.propertyId ?? null,
      input.propertyLabel ?? null,
      encrypted,
      metaJson,
    ]
  );
  return id;
}

function publicIntegration(row: StoredIntegration | null, provider: IntegrationProvider) {
  if (!row || row.status !== 'connected') {
    return {
      provider,
      connected: false,
      accountEmail: null as string | null,
      propertyId: null as string | null,
      propertyLabel: null as string | null,
      platformBacklinksReady: Boolean(env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD),
    };
  }
  return {
    provider,
    connected: true,
    accountEmail: row.accountEmail,
    propertyId: row.propertyId,
    propertyLabel: row.propertyLabel,
    platformBacklinksReady: Boolean(env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD),
  };
}

async function refreshGoogleToken(tokens: OAuthTokens): Promise<OAuthTokens> {
  if (!tokens.refresh_token) return tokens;
  const expiresAt = Number(tokens.expires_at || 0);
  if (expiresAt && expiresAt > Date.now() + 60_000) return tokens;
  const clientId = env.GOOGLE_CLIENT_ID || '';
  const clientSecret = env.GOOGLE_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) throw new AppError('Google OAuth is not configured', 503);
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  });
  const res = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }, 20_000);
  if (!res.ok) throw new AppError('Could not refresh Google access token', 502);
  const json = (await res.json()) as OAuthTokens;
  return {
    ...tokens,
    ...json,
    refresh_token: json.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + Number(json.expires_in || 3600) * 1000,
  };
}

async function getValidGoogleTokens(userId: string, provider: 'google_analytics' | 'google_search_console') {
  const row = await getIntegration(userId, provider);
  if (!row || row.status !== 'connected') throw new AppError('Integration not connected', 404);
  requireSecretBox();
  let tokens = decryptJson<OAuthTokens>(row.encryptedSecrets);
  const refreshed = await refreshGoogleToken(tokens);
  if (refreshed.access_token !== tokens.access_token || refreshed.expires_at !== tokens.expires_at) {
    tokens = refreshed;
    await db.execute(
      `UPDATE tbl_webreport_integration SET encryptedSecrets = ?, updatedAt = CURRENT_TIMESTAMP(3) WHERE id = ?`,
      [encryptJson(tokens), row.id]
    );
  }
  return { row, tokens };
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return url.replace(/^www\./i, '').toLowerCase();
  }
}

async function dataForSeoAuthHeader(userId: string): Promise<string | null> {
  const byo = await getIntegration(userId, 'backlinks');
  if (byo && byo.status === 'connected') {
    requireSecretBox();
    const secrets = decryptJson<BacklinkSecrets>(byo.encryptedSecrets);
    if (secrets.login && secrets.password) {
      return `Basic ${Buffer.from(`${secrets.login}:${secrets.password}`).toString('base64')}`;
    }
  }
  if (env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD) {
    return `Basic ${Buffer.from(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`).toString('base64')}`;
  }
  return null;
}

export const webreportsIntegrationsService = {
  async status(userId: string) {
    const [ga, gsc, backlinks] = await Promise.all([
      getIntegration(userId, 'google_analytics'),
      getIntegration(userId, 'google_search_console'),
      getIntegration(userId, 'backlinks'),
    ]);
    return {
      google_analytics: publicIntegration(ga, 'google_analytics'),
      google_search_console: publicIntegration(gsc, 'google_search_console'),
      backlinks: {
        ...publicIntegration(backlinks, 'backlinks'),
        connected: Boolean(
          (backlinks && backlinks.status === 'connected') ||
            (env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD)
        ),
        mode: backlinks && backlinks.status === 'connected' ? 'byo' : env.DATAFORSEO_LOGIN ? 'platform' : 'none',
      },
    };
  },

  async getAuthorizeUrl(userId: string, provider: 'google_analytics' | 'google_search_console') {
    const clientId = env.GOOGLE_CLIENT_ID || '';
    if (!clientId || !env.GOOGLE_CLIENT_SECRET) {
      throw new AppError('Google OAuth is not configured on the server', 503);
    }
    requireSecretBox();
    const nonce = crypto.randomBytes(16).toString('hex');
    const state = Buffer.from(JSON.stringify({ userId, provider, nonce })).toString('base64url');
    await redis.set(`webreports-oauth:${userId}:${nonce}`, provider, 'EX', OAUTH_STATE_TTL_SEC);
    const redirectUri = encodeURIComponent(oauthRedirectUri());
    const scope = encodeURIComponent(SCOPES[provider]);
    return {
      url: `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&response_type=code&redirect_uri=${redirectUri}&scope=${scope}&access_type=offline&prompt=consent&state=${state}`,
      redirectUri: oauthRedirectUri(),
    };
  },

  async exchangeOAuthCode(userId: string, code: string, stateRaw: string) {
    let state: { userId?: string; provider?: string; nonce?: string };
    try {
      state = JSON.parse(Buffer.from(stateRaw, 'base64url').toString('utf8'));
    } catch {
      throw new AppError('Invalid OAuth state', 400);
    }
    if (state.userId !== userId || !state.nonce) {
      throw new AppError('OAuth state does not match the signed-in user', 403);
    }
    const provider = String(state.provider || '') as 'google_analytics' | 'google_search_console';
    if (provider !== 'google_analytics' && provider !== 'google_search_console') {
      throw new AppError('Unsupported provider', 400);
    }
    const stored = await redis.get(`webreports-oauth:${userId}:${state.nonce}`);
    if (!stored) throw new AppError('OAuth state expired. Try Connect again.', 400);
    await redis.del(`webreports-oauth:${userId}:${state.nonce}`);

    const clientId = env.GOOGLE_CLIENT_ID || '';
    const clientSecret = env.GOOGLE_CLIENT_SECRET || '';
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: oauthRedirectUri(),
      grant_type: 'authorization_code',
    });
    const tokenRes = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }, 20_000);
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      throw new AppError(`Google token exchange failed: ${text.slice(0, 200)}`, 502);
    }
    const tokens = (await tokenRes.json()) as OAuthTokens;
    tokens.expires_at = Date.now() + Number(tokens.expires_in || 3600) * 1000;

    let email: string | null = null;
    try {
      const me = await fetchWithTimeout('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      }, 15_000);
      if (me.ok) {
        const profile = (await me.json()) as { email?: string };
        email = profile.email || null;
      }
    } catch {
      /* optional */
    }

    await upsertIntegration({
      userId,
      provider,
      accountEmail: email,
      secrets: tokens,
      meta: { scopes: SCOPES[provider] },
    });

    return { provider, accountEmail: email };
  },

  async disconnect(userId: string, provider: IntegrationProvider) {
    await db.execute(`DELETE FROM tbl_webreport_integration WHERE userId = ? AND provider = ?`, [
      userId,
      provider,
    ]);
    return { ok: true };
  },

  async saveBacklinksKey(userId: string, login: string, password: string) {
    const trimmedLogin = login.trim();
    const trimmedPassword = password.trim();
    if (!trimmedLogin || !trimmedPassword) throw new AppError('Login and password are required', 400);
    await upsertIntegration({
      userId,
      provider: 'backlinks',
      accountEmail: trimmedLogin,
      secrets: { login: trimmedLogin, password: trimmedPassword, source: 'byo' } satisfies BacklinkSecrets,
      propertyLabel: 'DataForSEO BYO',
    });
    return { ok: true };
  },

  async setProperty(
    userId: string,
    provider: 'google_analytics' | 'google_search_console',
    propertyId: string,
    propertyLabel?: string
  ) {
    const row = await getIntegration(userId, provider);
    if (!row) throw new AppError('Integration not connected', 404);
    await db.execute(
      `UPDATE tbl_webreport_integration
          SET propertyId = ?, propertyLabel = ?, updatedAt = CURRENT_TIMESTAMP(3)
        WHERE id = ?`,
      [propertyId, propertyLabel || propertyId, row.id]
    );
    return { ok: true };
  },

  async listGaProperties(userId: string) {
    const { tokens } = await getValidGoogleTokens(userId, 'google_analytics');
    const res = await fetchWithTimeout(
      'https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200',
      { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      20_000
    );
    if (!res.ok) {
      const text = await res.text();
      throw new AppError(`Could not list Analytics properties: ${text.slice(0, 180)}`, 502);
    }
    const json = (await res.json()) as {
      accountSummaries?: Array<{
        displayName?: string;
        propertySummaries?: Array<{ property?: string; displayName?: string }>;
      }>;
    };
    const properties: { id: string; label: string }[] = [];
    for (const account of json.accountSummaries || []) {
      for (const prop of account.propertySummaries || []) {
        if (!prop.property) continue;
        properties.push({
          id: prop.property,
          label: `${prop.displayName || prop.property} (${account.displayName || 'Account'})`,
        });
      }
    }
    return { properties };
  },

  async listGscSites(userId: string) {
    const { tokens } = await getValidGoogleTokens(userId, 'google_search_console');
    const res = await fetchWithTimeout('https://www.googleapis.com/webmasters/v3/sites', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    }, 20_000);
    if (!res.ok) {
      const text = await res.text();
      throw new AppError(`Could not list Search Console sites: ${text.slice(0, 180)}`, 502);
    }
    const json = (await res.json()) as {
      siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }>;
    };
    return {
      sites: (json.siteEntry || [])
        .filter((s) => s.siteUrl)
        .map((s) => ({ id: s.siteUrl as string, label: s.siteUrl as string })),
    };
  },

  async metrics(userId: string, hostOrUrl: string) {
    if (!hostOrUrl?.trim()) throw new AppError('host is required', 400);
    const host = hostFromUrl(hostOrUrl);
    const status = await this.status(userId);
    const result: {
      host: string;
      google_analytics: {
        connected: boolean;
        series: { date: string; sessions: number; users: number }[];
        sessions: number | null;
        users: number | null;
      };
      google_search_console: {
        connected: boolean;
        series: { date: string; clicks: number; impressions: number }[];
        clicks: number | null;
        impressions: number | null;
        keywords: { query: string; clicks: number; impressions: number; position: number }[];
      };
      backlinks: {
        connected: boolean;
        authorityScore: number | null;
        referringDomains: number | null;
        backlinks: number | null;
      };
    } = {
      host,
      google_analytics: { connected: status.google_analytics.connected, series: [], sessions: null, users: null },
      google_search_console: {
        connected: status.google_search_console.connected,
        series: [],
        clicks: null,
        impressions: null,
        keywords: [],
      },
      backlinks: {
        connected: status.backlinks.connected,
        authorityScore: null,
        referringDomains: null,
        backlinks: null,
      },
    };

    if (status.google_analytics.connected) {
      try {
        Object.assign(result.google_analytics, await this.fetchGaMetrics(userId, host));
        result.google_analytics.connected = true;
      } catch {
        /* leave empty */
      }
    }

    if (status.google_search_console.connected) {
      try {
        Object.assign(result.google_search_console, await this.fetchGscMetrics(userId, host));
        result.google_search_console.connected = true;
      } catch {
        /* leave empty */
      }
    }

    if (status.backlinks.connected) {
      try {
        Object.assign(result.backlinks, await this.fetchBacklinks(userId, host));
        result.backlinks.connected = true;
      } catch {
        /* leave empty */
      }
    }

    return result;
  },

  async fetchGaMetrics(userId: string, host: string) {
    const { row, tokens } = await getValidGoogleTokens(userId, 'google_analytics');
    let propertyId = row.propertyId;
    if (!propertyId) {
      const listed = await this.listGaProperties(userId);
      const match = listed.properties.find((p) => p.label.toLowerCase().includes(host));
      propertyId = match?.id || listed.properties[0]?.id || null;
      if (propertyId) {
        await this.setProperty(userId, 'google_analytics', propertyId, match?.label || propertyId);
      }
    }
    if (!propertyId) {
      return { connected: true, series: [], sessions: null, users: null };
    }
    const property = propertyId.startsWith('properties/') ? propertyId : `properties/${propertyId}`;
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 28);
    const body = {
      dateRanges: [
        {
          startDate: start.toISOString().slice(0, 10),
          endDate: end.toISOString().slice(0, 10),
        },
      ],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
    };
    const res = await fetchWithTimeout(
      `https://analyticsdata.googleapis.com/v1beta/${property}:runReport`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      25_000
    );
    if (!res.ok) {
      const text = await res.text();
      throw new AppError(`Analytics report failed: ${text.slice(0, 180)}`, 502);
    }
    const json = (await res.json()) as {
      rows?: Array<{ dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }>;
    };
    const series = (json.rows || []).map((r) => {
      const raw = r.dimensionValues?.[0]?.value || '';
      const date = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw;
      return {
        date,
        sessions: Number(r.metricValues?.[0]?.value || 0),
        users: Number(r.metricValues?.[1]?.value || 0),
      };
    });
    const sessions = series.reduce((s, x) => s + x.sessions, 0);
    const users = series.reduce((s, x) => s + x.users, 0);
    return { connected: true, series, sessions, users };
  },

  async fetchGscMetrics(userId: string, host: string) {
    const { row, tokens } = await getValidGoogleTokens(userId, 'google_search_console');
    let siteUrl = row.propertyId;
    if (!siteUrl) {
      const listed = await this.listGscSites(userId);
      const match =
        listed.sites.find((s) => s.id.includes(host)) ||
        listed.sites.find((s) => host.includes(s.id.replace(/^sc-domain:/, '').replace(/\/$/, '')));
      siteUrl = match?.id || listed.sites[0]?.id || null;
      if (siteUrl) await this.setProperty(userId, 'google_search_console', siteUrl, siteUrl);
    }
    if (!siteUrl) {
      return { connected: true, series: [], clicks: null, impressions: null, keywords: [] };
    }
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 28);
    const encoded = encodeURIComponent(siteUrl);
    const seriesRes = await fetchWithTimeout(
      `https://www.googleapis.com/webmasters/v3/sites/${encoded}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          startDate: start.toISOString().slice(0, 10),
          endDate: end.toISOString().slice(0, 10),
          dimensions: ['date'],
          rowLimit: 1000,
        }),
      },
      25_000
    );
    if (!seriesRes.ok) {
      const text = await seriesRes.text();
      throw new AppError(`Search Console report failed: ${text.slice(0, 180)}`, 502);
    }
    const seriesJson = (await seriesRes.json()) as {
      rows?: Array<{ keys?: string[]; clicks?: number; impressions?: number }>;
    };
    const series = (seriesJson.rows || []).map((r) => ({
      date: r.keys?.[0] || '',
      clicks: Number(r.clicks || 0),
      impressions: Number(r.impressions || 0),
    }));
    const kwRes = await fetchWithTimeout(
      `https://www.googleapis.com/webmasters/v3/sites/${encoded}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          startDate: start.toISOString().slice(0, 10),
          endDate: end.toISOString().slice(0, 10),
          dimensions: ['query'],
          rowLimit: 10,
        }),
      },
      25_000
    );
    const kwJson = kwRes.ok
      ? ((await kwRes.json()) as {
          rows?: Array<{ keys?: string[]; clicks?: number; impressions?: number; position?: number }>;
        })
      : { rows: [] };
    const keywords = (kwJson.rows || []).map((r) => ({
      query: r.keys?.[0] || '',
      clicks: Number(r.clicks || 0),
      impressions: Number(r.impressions || 0),
      position: Number(r.position || 0),
    }));
    return {
      connected: true,
      series,
      clicks: series.reduce((s, x) => s + x.clicks, 0),
      impressions: series.reduce((s, x) => s + x.impressions, 0),
      keywords,
    };
  },

  async fetchBacklinks(userId: string, host: string) {
    const auth = await dataForSeoAuthHeader(userId);
    if (!auth) {
      return { connected: false, authorityScore: null, referringDomains: null, backlinks: null };
    }
    const res = await fetchWithTimeout(
      'https://api.dataforseo.com/v3/backlinks/summary/live',
      {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([{ target: host, include_subdomains: true }]),
      },
      30_000
    );
    if (!res.ok) {
      const text = await res.text();
      throw new AppError(`Backlinks lookup failed: ${text.slice(0, 180)}`, 502);
    }
    const json = (await res.json()) as {
      tasks?: Array<{
        result?: Array<{
          rank?: number;
          referring_domains?: number;
          backlinks?: number;
        }>;
      }>;
    };
    const row = json.tasks?.[0]?.result?.[0];
    return {
      connected: true,
      authorityScore: row?.rank != null ? Math.min(100, Math.round(Number(row.rank) / 10)) : null,
      referringDomains: row?.referring_domains ?? null,
      backlinks: row?.backlinks ?? null,
    };
  },
};
