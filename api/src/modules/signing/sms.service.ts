import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { AppError } from '../../middleware/errorHandler.middleware';
import { fetchWithTimeout } from '../../lib/httpFetch';

/** True when Twilio (or a compatible account) is configured for SMS OTP. */
export function isSmsConfigured(): boolean {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER);
}

/**
 * Sends a short SMS via Twilio REST. Kept dependency-free (fetch) so the API
 * boots without Twilio packages when SMS is unused.
 */
export async function sendSms(to: string, body: string): Promise<void> {
  if (!isSmsConfigured()) {
    throw new AppError(
      'SMS verification is not configured. Ask the sender to use email verification instead.',
      503
    );
  }

  const sid = env.TWILIO_ACCOUNT_SID!;
  const token = env.TWILIO_AUTH_TOKEN!;
  const from = env.TWILIO_FROM_NUMBER!;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const form = new URLSearchParams({ To: to, From: from, Body: body });

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    },
    15_000
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error({ status: res.status, text: text.slice(0, 300) }, 'Twilio SMS failed');
    throw new AppError('Could not send the SMS verification code. Please try again later.', 503);
  }

  logger.info({ to: maskPhone(to) }, 'SMS OTP sent');
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-4)}`;
}
