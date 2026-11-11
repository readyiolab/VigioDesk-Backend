import crypto from 'crypto';
import { db } from './mysql';
import { logger } from './logger';
import { fetchWithTimeout } from './httpFetch';

export type OutboundEventType =
  | 'document.completed'
  | 'document.declined'
  | 'letter.batch.sent'
  | 'webreport.ready'
  | 'webreport.failed'
  | 'ai.summary.ready';

/**
 * Fire-and-forget outbound customer webhooks (HMAC-SHA256 of body).
 */
export async function emitOutboundWebhook(
  eventType: OutboundEventType,
  payload: Record<string, unknown>,
  opts: { userId: string; organizationId?: string | null }
): Promise<void> {
  try {
    const endpoints = await db.selectAll(
      'tbl_webhook_endpoint',
      'id, url, secret, eventsJson',
      'userId = ? AND enabled = 1',
      [opts.userId]
    );

    for (const ep of endpoints as any[]) {
      let events: string[] = [];
      try {
        events = Array.isArray(ep.eventsJson)
          ? ep.eventsJson
          : JSON.parse(String(ep.eventsJson || '[]'));
      } catch {
        events = [];
      }
      if (events.length && !events.includes(eventType) && !events.includes('*')) continue;

      const body = JSON.stringify({
        id: crypto.randomUUID(),
        type: eventType,
        createdAt: new Date().toISOString(),
        data: payload,
      });
      const signature = crypto.createHmac('sha256', String(ep.secret)).update(body).digest('hex');
      const deliveryId = crypto.randomUUID();

      await db.insert('tbl_webhook_delivery', {
        id: deliveryId,
        endpointId: ep.id,
        eventType,
        payloadJson: body,
        status: 'pending',
        attempts: 1,
      });

      try {
        const res = await fetchWithTimeout(
          String(ep.url),
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Vigodesk-Signature': signature,
              'X-Vigodesk-Event': eventType,
            },
            body,
          },
          10_000
        );
        await db.update(
          'tbl_webhook_delivery',
          {
            status: res.ok ? 'delivered' : 'failed',
            responseStatus: res.status,
            deliveredAt: res.ok ? new Date() : null,
            lastError: res.ok ? null : `HTTP ${res.status}`,
          },
          'id = ?',
          [deliveryId]
        );
      } catch (err) {
        await db.update(
          'tbl_webhook_delivery',
          {
            status: 'failed',
            lastError: err instanceof Error ? err.message : String(err),
          },
          'id = ?',
          [deliveryId]
        );
      }
    }
  } catch (err) {
    logger.warn({ err, eventType, userId: opts.userId }, 'Outbound webhook emit failed');
  }
}
