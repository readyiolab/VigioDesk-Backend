import { AppError } from '../../middleware/errorHandler.middleware';
import { db } from '../../lib/mysql';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { PLAN_LIMITS } from '../../../../shared/constants';
import { asPlan } from '../../lib/storage';
import type { Plan } from '../../../../shared/types';
import { getAiProvider, isAiConfigured } from '../../lib/ai/provider';
import { toAiAppError } from '../../lib/ai/errors';
import { withAiSlot } from '../../lib/aiSemaphore';
import { parseModelJson } from '../letters/parseModelJson';
import {
  diagramDocumentSchema,
  diagramPageSchema,
  diagramPatchOpSchema,
  type DiagramDocument,
  type DiagramPage,
  type DiagramPatchOp,
} from './diagrams.types';
import { emptyDocument } from './diagrams.service';
import crypto from 'crypto';

const AI_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const DIAGRAM_AI_OPTS = { maxTokens: 3000, jsonMode: true, timeoutMs: 60_000 } as const;
const DIAGRAM_AI_REPAIR_OPTS = { maxTokens: 3000, jsonMode: true, timeoutMs: 45_000 } as const;

const GENERATE_SYSTEM = `You generate diagrams. Return ONLY JSON (no markdown):
{"version":2,"pages":[{"id":"<uuid>","name":"Page-1","nodes":[{"id":"<uuid>","label":"...","shape":"rectangle|rounded|ellipse|diamond|hexagon|cylinder","x":number,"y":number,"w":number,"h":number,"kind":"shape"}],"edges":[{"id":"<uuid>","source":"<nodeId>","target":"<nodeId>","label":""}]}],"settings":{"grid":true,"gridSize":10,"pageView":true,"background":"#ffffff","theme":"automatic","paper":"a4-portrait","pageWidth":794,"pageHeight":1123}}
Rules: prefer 6-20 nodes; unique ids; edges reference existing nodes; space nodes ~160px apart; for ER diagrams use rectangle=entity, diamond=relationship, ellipse=attribute; keep output compact.`;

const EDIT_SYSTEM = `You edit a diagram page. Return ONLY a JSON object:
{"ops":[ ...patch operations... ]}
Allowed ops (discriminated by "op"):
- {"op":"addNode","node":{id,label,shape,x,y,w,h,kind?,style?}}
- {"op":"updateNode","id":"...","changes":{label?,shape?,x?,y?,w?,h?,style?}}
- {"op":"removeNode","id":"..."}
- {"op":"addEdge","edge":{id,source,target,label?,style?}}
- {"op":"updateEdge","id":"...","changes":{source?,target?,label?,style?}}
- {"op":"removeEdge","id":"..."}
- {"op":"relabel","id":"...","label":"..."}
No markdown. Prefer few ops. Always wrap ops in {"ops":[...]}.`;

const REPAIR_DOC_SYSTEM =
  'Fix into valid DiagramDocument JSON only: {"version":2,"pages":[...],"settings":{...}}. No markdown.';

const REPAIR_PATCH_SYSTEM =
  'Fix into valid JSON object {"ops":[...]} of diagram patch ops only. No markdown.';

/** Atomic monthly-credit reservation — same guarded UPDATE as ai.service. */
async function reserveAiCredit(userId: string, limit: number, plan: Plan): Promise<void> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - AI_WINDOW_MS);
  const reserve = await db.execute(
    `UPDATE tbl_user
        SET monthlyAiUsed    = IF(monthlyAiResetAt < ?, 1, monthlyAiUsed + 1),
            monthlyAiResetAt = IF(monthlyAiResetAt < ?, ?, monthlyAiResetAt)
      WHERE id = ? AND (monthlyAiResetAt < ? OR monthlyAiUsed < ?)`,
    [cutoff, cutoff, now, userId, cutoff, limit]
  );
  if (reserve.affectedRows === 0) {
    throw new AppError(
      plan === 'FREE'
        ? `You've used all ${limit} free AI requests this month. Upgrade to PRO for more.`
        : `You've used all ${limit} AI requests for this month. It resets on a rolling 30-day basis.`,
      403
    );
  }
  void db
    .insert('tbl_ai_usage', {
      id: crypto.randomUUID(),
      userId,
      feature: 'diagram-ai',
      credits: 1,
      metaJson: JSON.stringify({ plan }),
    })
    .catch(() => undefined);
}

async function refundAiCredit(userId: string): Promise<void> {
  await db.execute(
    'UPDATE tbl_user SET monthlyAiUsed = GREATEST(monthlyAiUsed - 1, 0) WHERE id = ?',
    [userId]
  );
}

function applyPatches(page: DiagramPage, ops: DiagramPatchOp[]): DiagramPage {
  let nodes = [...page.nodes];
  let edges = [...page.edges];

  for (const op of ops) {
    switch (op.op) {
      case 'addNode':
        nodes.push(op.node);
        break;
      case 'updateNode':
        nodes = nodes.map((n) =>
          n.id === op.id ? { ...n, ...op.changes, id: n.id } : n
        );
        break;
      case 'removeNode':
        nodes = nodes.filter((n) => n.id !== op.id);
        edges = edges.filter((e) => e.source !== op.id && e.target !== op.id);
        break;
      case 'addEdge':
        edges.push(op.edge);
        break;
      case 'updateEdge':
        edges = edges.map((e) =>
          e.id === op.id ? { ...e, ...op.changes, id: e.id } : e
        );
        break;
      case 'removeEdge':
        edges = edges.filter((e) => e.id !== op.id);
        break;
      case 'relabel':
        nodes = nodes.map((n) => (n.id === op.id ? { ...n, label: op.label } : n));
        edges = edges.map((e) => (e.id === op.id ? { ...e, label: op.label } : e));
        break;
      default:
        break;
    }
  }

  return { ...page, nodes, edges };
}

function normalizeAiDocument(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const doc = raw as Record<string, unknown>;
  // Common wrappers: { document }, { diagram }, { result }
  const unwrapped =
    doc.pages
      ? doc
      : doc.document && typeof doc.document === 'object'
        ? (doc.document as Record<string, unknown>)
        : doc.diagram && typeof doc.diagram === 'object'
          ? (doc.diagram as Record<string, unknown>)
          : doc;
  const pages = Array.isArray(unwrapped.pages) ? unwrapped.pages : [];
  const settings: Record<string, unknown> =
    unwrapped.settings && typeof unwrapped.settings === 'object'
      ? { ...(unwrapped.settings as Record<string, unknown>) }
      : {
          grid: true,
          gridSize: 10,
          pageView: true,
          background: '#ffffff',
          theme: 'automatic',
          paper: 'a4-portrait',
          pageWidth: 794,
          pageHeight: 1123,
        };

  const validThemes = new Set(['automatic', 'classic', 'simple', 'minimal', 'sketch', 'atlas']);
  if (typeof settings.theme === 'string' && !validThemes.has(settings.theme)) {
    settings.theme = 'automatic';
  }
  if (settings.paper == null) settings.paper = 'a4-portrait';
  if (settings.pageWidth == null) settings.pageWidth = 794;
  if (settings.pageHeight == null) settings.pageHeight = 1123;

  const normalizedPages = (pages.length ? pages : [{ name: 'Page-1', nodes: [], edges: [] }]).map(
    (page, index) => normalizeAiPage(page, index)
  );

  return {
    version: unwrapped.version === 1 ? 1 : 2,
    pages: normalizedPages,
    settings,
  };
}

function normalizeAiPage(raw: unknown, index: number) {
  const page = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const nodesRaw = Array.isArray(page.nodes) ? page.nodes : [];
  const edgesRaw = Array.isArray(page.edges) ? page.edges : [];
  const nodes = nodesRaw.map(normalizeAiNode);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = edgesRaw
    .map(normalizeAiEdge)
    .filter((e) => e.source && e.target && nodeIds.has(e.source) && nodeIds.has(e.target));
  return {
    id: String(page.id || crypto.randomUUID()),
    name: String(page.name || `Page-${index + 1}`),
    nodes,
    edges,
  };
}

function normalizeAiNode(raw: unknown) {
  const node = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const w = Number(node.w);
  const h = Number(node.h);
  const kind =
    typeof node.kind === 'string' &&
    ['shape', 'freehand', 'table', 'container', 'text'].includes(node.kind)
      ? node.kind
      : 'shape';
  const style =
    node.style && typeof node.style === 'object'
      ? (node.style as Record<string, unknown>)
      : undefined;
  return {
    id: String(node.id || crypto.randomUUID()),
    label: String(node.label ?? node.name ?? ''),
    shape: String(node.shape || node.type || 'rectangle'),
    x: Number.isFinite(Number(node.x)) ? Number(node.x) : 40,
    y: Number.isFinite(Number(node.y)) ? Number(node.y) : 40,
    w: Number.isFinite(w) && w > 0 ? w : 120,
    h: Number.isFinite(h) && h > 0 ? h : 60,
    kind,
    ...(style ? { style } : {}),
  };
}

function normalizeAiEdge(raw: unknown) {
  const edge = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const style =
    edge.style && typeof edge.style === 'object'
      ? (edge.style as Record<string, unknown>)
      : undefined;
  if (style?.arrow != null) {
    const arrow = String(style.arrow);
    const ok = ['classic', 'block', 'open', 'oval', 'diamond', 'none'];
    if (!ok.includes(arrow)) delete style.arrow;
  }
  return {
    id: String(edge.id || crypto.randomUUID()),
    source: String(edge.source || edge.from || ''),
    target: String(edge.target || edge.to || ''),
    label: edge.label != null ? String(edge.label) : '',
    ...(style ? { style } : {}),
  };
}

/** Slim page for edit prompts — cuts tokens / latency. */
function slimPageForAi(page: DiagramPage): unknown {
  return {
    id: page.id,
    name: page.name,
    nodes: page.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      shape: n.shape,
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
      kind: n.kind ?? 'shape',
    })),
    edges: page.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label ?? '',
    })),
  };
}

function unwrapPatchOps(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    for (const key of ['ops', 'patches', 'operations', 'changes', 'edits']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  throw new AppError('AI returned an invalid patch payload', 422);
}

function normalizeAiPatchOp(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const op = { ...(raw as Record<string, unknown>) };
  if (op.op === 'addNode' && op.node) op.node = normalizeAiNode(op.node);
  if (op.op === 'addEdge' && op.edge) op.edge = normalizeAiEdge(op.edge);
  if (op.op === 'updateNode' && op.changes && typeof op.changes === 'object') {
    const c = { ...(op.changes as Record<string, unknown>) };
    if (c.w != null) {
      const w = Number(c.w);
      c.w = Number.isFinite(w) && w > 0 ? w : undefined;
    }
    if (c.h != null) {
      const h = Number(c.h);
      c.h = Number.isFinite(h) && h > 0 ? h : undefined;
    }
    op.changes = c;
  }
  return op;
}

function parseAndValidateDocument(raw: string): DiagramDocument {
  const parsed = parseModelJson(raw);
  const normalized = normalizeAiDocument(parsed);
  return diagramDocumentSchema.parse(normalized);
}

function parseAndValidatePatches(raw: string): DiagramPatchOp[] {
  const parsed = parseModelJson(raw);
  const list = unwrapPatchOps(parsed);
  return list.map((op, i) => {
    const result = diagramPatchOpSchema.safeParse(normalizeAiPatchOp(op));
    if (!result.success) {
      throw new AppError(`Invalid patch op at index ${i}`, 422);
    }
    return result.data;
  });
}

async function withCredit<T>(userId: string, plan: Plan, fn: () => Promise<T>): Promise<T> {
  const normalized = asPlan(plan);
  await reserveAiCredit(userId, PLAN_LIMITS[normalized].maxMonthlyAiCredits, normalized);
  try {
    return await fn();
  } catch (err) {
    await refundAiCredit(userId).catch(() => undefined);
    throw err;
  }
}

export const diagramAiService = {
  async generate(userId: string, plan: Plan, prompt: string) {
    if (!isAiConfigured()) {
      throw new AppError('Diagram AI is not configured. Set OPENAI_API_KEY.', 503);
    }
    const provider = getAiProvider();

    return withAiSlot('diagram', userId, 2, () =>
    withCredit(userId, plan, async () => {
      try {
        const first = await provider.complete(
          [
            { role: 'system', content: GENERATE_SYSTEM },
            { role: 'user', content: prompt },
          ],
          DIAGRAM_AI_OPTS
        );

        let document: DiagramDocument;
        try {
          document = parseAndValidateDocument(first.text);
        } catch {
          const repair = await provider.complete(
            [
              { role: 'system', content: REPAIR_DOC_SYSTEM },
              { role: 'user', content: first.text },
            ],
            DIAGRAM_AI_REPAIR_OPTS
          );
          try {
            document = parseAndValidateDocument(repair.text);
          } catch {
            throw new AppError('AI could not produce a valid diagram document', 422);
          }
        }

        logger.info(
          { userId, model: env.AI_MODEL, ...first.usage },
          'Diagram AI generate'
        );
        return { document };
      } catch (err) {
        if (err instanceof AppError) throw err;
        logger.error({ err, userId }, 'Diagram AI generate failed');
        throw toAiAppError(err);
      }
    })
    );
  },

  async edit(userId: string, plan: Plan, instruction: string, page: DiagramPage) {
    if (!isAiConfigured()) {
      throw new AppError('Diagram AI is not configured. Set OPENAI_API_KEY.', 503);
    }
    const provider = getAiProvider();
    const validatedPage = diagramPageSchema.parse(page);
    const slim = slimPageForAi(validatedPage);

    return withAiSlot('diagram', userId, 2, () =>
    withCredit(userId, plan, async () => {
      try {
        const first = await provider.complete(
          [
            { role: 'system', content: EDIT_SYSTEM },
            {
              role: 'user',
              content: `Instruction: ${instruction}\n\nCurrent page JSON:\n${JSON.stringify(slim)}`,
            },
          ],
          DIAGRAM_AI_OPTS
        );

        let patch: DiagramPatchOp[];
        try {
          patch = parseAndValidatePatches(first.text);
        } catch {
          const repair = await provider.complete(
            [
              { role: 'system', content: REPAIR_PATCH_SYSTEM },
              { role: 'user', content: first.text },
            ],
            DIAGRAM_AI_REPAIR_OPTS
          );
          try {
            patch = parseAndValidatePatches(repair.text);
          } catch {
            throw new AppError('AI could not produce a valid diagram patch', 422);
          }
        }

        const nextPage = diagramPageSchema.parse(applyPatches(validatedPage, patch));
        logger.info(
          { userId, model: env.AI_MODEL, ops: patch.length },
          'Diagram AI edit'
        );
        return { patch, page: nextPage };
      } catch (err) {
        if (err instanceof AppError) throw err;
        logger.error({ err, userId }, 'Diagram AI edit failed');
        throw toAiAppError(err);
      }
    })
    );
  },

  async fromImage(
    userId: string,
    plan: Plan,
    imageBase64: string,
    mimeType: string,
    prompt?: string
  ) {
    if (!isAiConfigured()) {
      throw new AppError('Diagram AI is not configured. Set OPENAI_API_KEY.', 503);
    }
    const provider = getAiProvider();
    if (!provider.completeVision) {
      throw new AppError('Vision is not available on the configured AI provider.', 503);
    }

    const cleaned = imageBase64.replace(/^data:[^;]+;base64,/, '');
    const dataUrl = `data:${mimeType};base64,${cleaned}`;
    const userText =
      prompt?.trim() ||
      'Convert this image into a DiagramDocument JSON matching our schema. Infer shapes, labels, and connections.';

    return withAiSlot('diagram', userId, 2, () =>
    withCredit(userId, plan, async () => {
      try {
        const first = await provider.completeVision!(
          [
            { role: 'system', content: GENERATE_SYSTEM },
            {
              role: 'user',
              content: [
                { type: 'text', text: userText },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
          DIAGRAM_AI_OPTS
        );

        let document: DiagramDocument;
        try {
          document = parseAndValidateDocument(first.text);
        } catch {
          const repair = await provider.complete(
            [
              { role: 'system', content: REPAIR_DOC_SYSTEM },
              { role: 'user', content: first.text || JSON.stringify(emptyDocument()) },
            ],
            DIAGRAM_AI_REPAIR_OPTS
          );
          try {
            document = parseAndValidateDocument(repair.text);
          } catch {
            throw new AppError('AI could not produce a valid diagram from the image', 422);
          }
        }

        logger.info(
          { userId, model: env.AI_MODEL, ...first.usage },
          'Diagram AI fromImage'
        );
        return { document };
      } catch (err) {
        if (err instanceof AppError) throw err;
        logger.error({ err, userId }, 'Diagram AI fromImage failed');
        throw toAiAppError(err);
      }
    })
    );
  },

  async analyze(userId: string, plan: Plan, page: DiagramPage) {
    if (!isAiConfigured()) {
      throw new AppError('Diagram AI is not configured. Set OPENAI_API_KEY.', 503);
    }
    const provider = getAiProvider();
    const validatedPage = diagramPageSchema.parse(page);

    // Local graph checks first (no credit) — AI adds semantic issues.
    const localIssues = localAnalyze(validatedPage);

    return withCredit(userId, plan, async () => {
      try {
        const first = await provider.complete(
          [
            {
              role: 'system',
              content: `You analyze architecture diagrams. Return ONLY JSON:
{"issues":[{"severity":"error"|"warning"|"info","kind":"string","message":"string","nodeIds":["..."],"edgeIds":["..."]}]}
Detect: broken/dangling edges, disconnected components, duplicates, missing return paths, circular deps, poor naming, overlaps, unclear flows. No markdown.`,
            },
            { role: 'user', content: JSON.stringify(validatedPage) },
          ],
          { maxTokens: 2048, jsonMode: true, timeoutMs: 60_000 }
        );
        let aiIssues: any[] = [];
        try {
          const parsed = parseModelJson(first.text) as { issues?: unknown };
          if (Array.isArray(parsed?.issues)) aiIssues = parsed.issues;
        } catch {
          /* keep local only */
        }
        const issues = [...localIssues, ...aiIssues].slice(0, 40);
        logger.info({ userId, count: issues.length }, 'Diagram AI analyze');
        return { issues };
      } catch (err) {
        if (err instanceof AppError) throw err;
        logger.error({ err, userId }, 'Diagram AI analyze failed');
        return { issues: localIssues };
      }
    });
  },

  async explain(userId: string, plan: Plan, page: DiagramPage) {
    if (!isAiConfigured()) {
      throw new AppError('Diagram AI is not configured. Set OPENAI_API_KEY.', 503);
    }
    const provider = getAiProvider();
    const validatedPage = diagramPageSchema.parse(page);

    return withCredit(userId, plan, async () => {
      try {
        const first = await provider.complete(
          [
            {
              role: 'system',
              content: `Explain this diagram step-by-step. Return ONLY JSON:
{"summary":"string","steps":[{"index":1,"title":"string","detail":"string","nodeIds":["id"]}]}
Each step should reference real node ids from the page. No markdown.`,
            },
            { role: 'user', content: JSON.stringify(validatedPage) },
          ],
          { maxTokens: 2048, jsonMode: true, timeoutMs: 60_000 }
        );
        const parsed = parseModelJson(first.text) as {
          summary?: string;
          steps?: Array<{ index?: number; title?: string; detail?: string; nodeIds?: string[] }>;
        };
        const steps = (parsed.steps || []).map((s, i) => ({
          index: s.index ?? i + 1,
          title: String(s.title || `Step ${i + 1}`),
          detail: String(s.detail || ''),
          nodeIds: Array.isArray(s.nodeIds) ? s.nodeIds.map(String) : [],
        }));
        return { summary: String(parsed.summary || ''), steps };
      } catch (err) {
        if (err instanceof AppError) throw err;
        logger.error({ err, userId }, 'Diagram AI explain failed');
        throw toAiAppError(err);
      }
    });
  },

  async explainSelection(
    userId: string,
    plan: Plan,
    page: DiagramPage,
    nodeIds: string[]
  ) {
    if (!isAiConfigured()) {
      throw new AppError('Diagram AI is not configured. Set OPENAI_API_KEY.', 503);
    }
    const provider = getAiProvider();
    const validatedPage = diagramPageSchema.parse(page);
    const idSet = new Set(nodeIds);
    const nodes = validatedPage.nodes.filter((n) => idSet.has(n.id));
    const edges = validatedPage.edges.filter(
      (e) => idSet.has(e.source) || idSet.has(e.target)
    );

    return withCredit(userId, plan, async () => {
      try {
        const first = await provider.complete(
          [
            {
              role: 'system',
              content:
                'Explain the selected diagram components in clear prose (2-5 sentences). Return ONLY JSON: {"explanation":"..."}. No markdown.',
            },
            {
              role: 'user',
              content: JSON.stringify({ nodes, edges, fullPage: validatedPage }),
            },
          ],
          { maxTokens: 1024, jsonMode: true, timeoutMs: 60_000 }
        );
        const parsed = parseModelJson(first.text) as { explanation?: string };
        return { explanation: String(parsed.explanation || first.text) };
      } catch (err) {
        if (err instanceof AppError) throw err;
        logger.error({ err, userId }, 'Diagram AI explainSelection failed');
        throw toAiAppError(err);
      }
    });
  },

  async diffSummary(
    userId: string,
    plan: Plan,
    fromDoc: DiagramDocument,
    toDoc: DiagramDocument,
    fromVersion: number,
    toVersion: number
  ) {
    if (!isAiConfigured()) {
      throw new AppError('Diagram AI is not configured. Set OPENAI_API_KEY.', 503);
    }
    const provider = getAiProvider();

    return withCredit(userId, plan, async () => {
      try {
        const first = await provider.complete(
          [
            {
              role: 'system',
              content: `Summarize what changed between two diagram versions in 3-6 bullet points as plain text paragraphs. Return ONLY JSON: {"summary":"..."}. No markdown fences.`,
            },
            {
              role: 'user',
              content: JSON.stringify({
                fromVersion,
                toVersion,
                from: fromDoc,
                to: toDoc,
              }),
            },
          ],
          { maxTokens: 1024, jsonMode: true, timeoutMs: 60_000 }
        );
        const parsed = parseModelJson(first.text) as { summary?: string };
        return { summary: String(parsed.summary || first.text) };
      } catch (err) {
        if (err instanceof AppError) throw err;
        logger.error({ err, userId }, 'Diagram AI diffSummary failed');
        throw toAiAppError(err);
      }
    });
  },
};

function localAnalyze(page: DiagramPage) {
  const issues: Array<{
    severity: 'error' | 'warning' | 'info';
    kind: string;
    message: string;
    nodeIds?: string[];
    edgeIds?: string[];
  }> = [];
  const nodeIds = new Set(page.nodes.map((n) => n.id));
  const labels = new Map<string, string[]>();

  for (const e of page.edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) {
      issues.push({
        severity: 'error',
        kind: 'dangling_edge',
        message: `Connector "${e.label || e.id}" references a missing shape.`,
        edgeIds: [e.id],
      });
    }
  }

  for (const n of page.nodes) {
    const key = (n.label || '').trim().toLowerCase();
    if (!key) {
      issues.push({
        severity: 'warning',
        kind: 'unnamed',
        message: 'A shape has no label.',
        nodeIds: [n.id],
      });
    } else {
      const list = labels.get(key) || [];
      list.push(n.id);
      labels.set(key, list);
    }
  }
  for (const [, ids] of labels) {
    if (ids.length > 1) {
      issues.push({
        severity: 'warning',
        kind: 'duplicate',
        message: 'Duplicate component labels detected.',
        nodeIds: ids,
      });
    }
  }

  // Overlaps (axis-aligned AABB)
  for (let i = 0; i < page.nodes.length; i++) {
    for (let j = i + 1; j < page.nodes.length; j++) {
      const a = page.nodes[i]!;
      const b = page.nodes[j]!;
      if (
        a.x < b.x + b.w &&
        a.x + a.w > b.x &&
        a.y < b.y + b.h &&
        a.y + a.h > b.y
      ) {
        issues.push({
          severity: 'info',
          kind: 'overlap',
          message: `"${a.label || 'Shape'}" overlaps "${b.label || 'Shape'}".`,
          nodeIds: [a.id, b.id],
        });
      }
    }
  }

  // Disconnected components (simple BFS)
  if (page.nodes.length > 1) {
    const adj = new Map<string, Set<string>>();
    for (const n of page.nodes) adj.set(n.id, new Set());
    for (const e of page.edges) {
      if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
      adj.get(e.source)!.add(e.target);
      adj.get(e.target)!.add(e.source);
    }
    const seen = new Set<string>();
    const start = page.nodes[0]!.id;
    const q = [start];
    seen.add(start);
    while (q.length) {
      const cur = q.shift()!;
      for (const n of adj.get(cur) || []) {
        if (!seen.has(n)) {
          seen.add(n);
          q.push(n);
        }
      }
    }
    const isolated = page.nodes.filter((n) => !seen.has(n.id)).map((n) => n.id);
    if (isolated.length) {
      issues.push({
        severity: 'warning',
        kind: 'disconnected',
        message: `${isolated.length} component(s) are disconnected from the main flow.`,
        nodeIds: isolated.slice(0, 12),
      });
    }
  }

  return issues;
}
