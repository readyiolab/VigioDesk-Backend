import { summaryMatchesEvidence, templateSummary, type SummaryPayload } from '../../../shared/webreports/summary';
import { logger } from './runtime';

export async function buildSummary(
  payload: SummaryPayload,
  apiKey: string | undefined,
  model: string,
  timeoutMs: number
): Promise<{ headline: string; text: string }> {
  const fallback = templateSummary(payload);
  if (!apiKey) return fallback;
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey, timeout: timeoutMs });
    const message = await client.messages.create({
      model,
      max_tokens: 400,
      messages: [
        {
          role: 'user',
          content: `Write a website audit summary from this JSON only. Do not invent metrics, findings, or guarantees. Return JSON {"headline":"","text":""}. Headline under 120 characters. Text is 3 or 4 sentences.\n${JSON.stringify(payload).slice(0, 6000)}`,
        },
      ],
    });
    const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    const parsed = JSON.parse(match[0]) as { headline?: string; text?: string };
    if (!parsed.headline || !parsed.text) return fallback;
    const headline = parsed.headline.slice(0, 180);
    const body = parsed.text.slice(0, 900);
    if (!summaryMatchesEvidence(`${headline} ${body}`, payload)) return fallback;
    return { headline, text: body };
  } catch (err) {
    logger.warn({ err }, 'Summary model failed; using template');
    return fallback;
  }
}
