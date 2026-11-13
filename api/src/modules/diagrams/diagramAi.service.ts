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

const DIAGRAM_AI_OPTS = { maxTokens: 4000, jsonMode: true, timeoutMs: 60_000 } as const;
const DIAGRAM_AI_REPAIR_OPTS = { maxTokens: 4000, jsonMode: true, timeoutMs: 45_000 } as const;

const GENERATE_SYSTEM = `You generate diagrams. Return ONLY JSON (no markdown):
{"version":2,"pages":[{"id":"<uuid>","name":"Page-1","nodes":[{"id":"<uuid>","label":"...","shape":"rectangle|rounded|ellipse|diamond|hexagon|cylinder","x":number,"y":number,"w":number,"h":number,"kind":"shape"}],"edges":[{"id":"<uuid>","source":"<nodeId>","target":"<nodeId>","label":""}]}],"settings":{"grid":true,"gridSize":10,"pageView":true,"background":"#ffffff","theme":"automatic","paper":"a4-portrait","pageWidth":794,"pageHeight":1123}}
Rules: prefer 6-20 nodes; unique ids; edges reference existing nodes; space nodes ~160px apart; for ER diagrams use rectangle=entity, diamond=relationship, ellipse=attribute; keep output compact.`;

/** Prefer full-page JSON — much more reliable than patch ops with jsonMode. */
const EDIT_SYSTEM = `You edit the CURRENT diagram page. Return ONLY the full updated page as JSON:
{"id":"<keep>","name":"<keep or update>","nodes":[{"id":"<uuid>","label":"...","shape":"rectangle|rounded|ellipse|diamond|hexagon|cylinder","x":number,"y":number,"w":number,"h":number,"kind":"shape"}],"edges":[{"id":"<uuid>","source":"<nodeId>","target":"<nodeId>","label":""}]}
Rules:
- Keep the same page id.
- Keep existing node/edge ids when those elements stay; new elements need new uuid ids.
- Apply the instruction (add/remove/rename/reconnect shapes).
- If asked to "add a page/section/sheet", add the requested shapes+edges ON THIS page (do not invent pages).
- Prefer 4-24 nodes; space ~160px apart; ER: rectangle=entity, diamond=relationship, ellipse=attribute.
- No markdown, no ops/patches wrapper, no settings document.`;

const REPAIR_DOC_SYSTEM =
  'Fix into valid DiagramDocument JSON only: {"version":2,"pages":[...],"settings":{...}}. No markdown.';

const REPAIR_PAGE_SYSTEM =
  'Fix into a valid diagram page JSON only: {"id":"...","name":"...","nodes":[...],"edges":[...]}. No markdown, no ops array.';

const REPAIR_PATCH_SYSTEM =
  'Convert into valid {"ops":[...]} using only addNode/updateNode/removeNode/addEdge/updateEdge/removeEdge/relabel. Each addNode must nest fields under "node"; each addEdge under "edge". No markdown.';

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

function sanitizeNodeStyle(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = { ...(raw as Record<string, unknown>) };
  for (const key of ['strokeWidth', 'fontSize', 'fontStyle', 'opacity', 'rotation'] as const) {
    if (s[key] != null) {
      const n = Number(s[key]);
      if (!Number.isFinite(n)) delete s[key];
      else s[key] = n;
    }
  }
  for (const key of ['dashed', 'rounded', 'shadow'] as const) {
    if (s[key] != null && typeof s[key] !== 'boolean') delete s[key];
  }
  return s;
}

function sanitizeEdgeStyle(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = { ...(raw as Record<string, unknown>) };
  const arrowOk = new Set(['classic', 'block', 'open', 'oval', 'diamond', 'none']);
  const edgeOk = new Set(['orthogonal', 'straight', 'entityRelation', 'elbow']);
  const jumpOk = new Set(['none', 'arc', 'gap', 'sharp']);
  for (const key of ['arrow', 'startArrow'] as const) {
    if (s[key] != null && !arrowOk.has(String(s[key]))) delete s[key];
  }
  if (s.edgeStyle != null && !edgeOk.has(String(s.edgeStyle))) delete s.edgeStyle;
  if (s.jumpStyle != null && !jumpOk.has(String(s.jumpStyle))) delete s.jumpStyle;
  for (const key of ['strokeWidth', 'fontSize', 'exitX', 'exitY', 'entryX', 'entryY', 'jumpSize'] as const) {
    if (s[key] != null) {
      const n = Number(s[key]);
      if (!Number.isFinite(n)) delete s[key];
      else s[key] = n;
    }
  }
  for (const key of ['dashed', 'curved', 'exitPerimeter', 'entryPerimeter', 'floating'] as const) {
    if (s[key] != null && typeof s[key] !== 'boolean') delete s[key];
  }
  if (Array.isArray(s.points)) {
    const pts = (s.points as unknown[])
      .map((p) => {
        if (!Array.isArray(p) || p.length < 2) return null;
        const x = Number(p[0]);
        const y = Number(p[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return [x, y] as [number, number];
      })
      .filter((p): p is [number, number] => p != null);
    if (pts.length) s.points = pts;
    else delete s.points;
  }
  return s;
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
  const style = sanitizeNodeStyle(node.style);
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
  const style = sanitizeEdgeStyle(edge.style);
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

const OP_ALIASES: Record<string, string> = {
  addnode: 'addNode',
  add_node: 'addNode',
  createnode: 'addNode',
  create_node: 'addNode',
  updatenode: 'updateNode',
  update_node: 'updateNode',
  removenode: 'removeNode',
  remove_node: 'removeNode',
  deletenode: 'removeNode',
  delete_node: 'removeNode',
  addedge: 'addEdge',
  add_edge: 'addEdge',
  createedge: 'addEdge',
  create_edge: 'addEdge',
  updateedge: 'updateEdge',
  update_edge: 'updateEdge',
  removeedge: 'removeEdge',
  remove_edge: 'removeEdge',
  deleteedge: 'removeEdge',
  delete_edge: 'removeEdge',
  relabel: 'relabel',
  rename: 'relabel',
};

function unwrapPatchOps(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    for (const key of ['ops', 'patches', 'operations', 'changes', 'edits']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return null;
}

function looksLikePage(raw: unknown): boolean {
  return Boolean(raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).nodes));
}

function looksLikeDocument(raw: unknown): boolean {
  return Boolean(raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).pages));
}

/** When the model returns a full page/document instead of patches. */
function tryParseAsEditedPage(raw: string, current: DiagramPage): DiagramPage | null {
  try {
    const parsed = parseModelJson(raw);
    let pageRaw: unknown = null;
    if (looksLikeDocument(parsed)) {
      const pages = (parsed as { pages: unknown[] }).pages;
      pageRaw = pages[0] ?? null;
    } else if (looksLikePage(parsed)) {
      pageRaw = parsed;
    } else if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      for (const key of ['page', 'result', 'data', 'diagram']) {
        const inner = obj[key];
        if (looksLikePage(inner)) {
          pageRaw = inner;
          break;
        }
        if (looksLikeDocument(inner)) {
          pageRaw = (inner as { pages: unknown[] }).pages[0] ?? null;
          break;
        }
      }
      // { ops: [...], page: {...} } already handled; also accept nodes at top via wrapper miss
      if (!pageRaw && Array.isArray(obj.nodes)) pageRaw = obj;
    }
    if (!pageRaw) return null;
    const normalized = normalizeAiPage(pageRaw, 0);
    // Reject total wipe of a non-empty page (likely truncated/bad output)
    if (current.nodes.length > 0 && normalized.nodes.length === 0) return null;
    return diagramPageSchema.parse({
      ...normalized,
      id: current.id,
      name: current.name || normalized.name,
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), preview: String(raw).slice(0, 300) },
      'Diagram AI could not parse edited page'
    );
    return null;
  }
}

function normalizeAiPatchOp(raw: unknown): unknown | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const opKey = String(src.op ?? src.action ?? src.type ?? '')
    .trim()
    .replace(/[\s-]+/g, '_');
  const opName = OP_ALIASES[opKey.toLowerCase()] ?? (opKey || null);
  if (!opName) return null;

  if (opName === 'addNode') {
    const nodeRaw =
      src.node && typeof src.node === 'object'
        ? src.node
        : (() => {
            const { op: _o, action: _a, type: _t, node: _n, ...rest } = src;
            return rest;
          })();
    return { op: 'addNode', node: normalizeAiNode(nodeRaw) };
  }

  if (opName === 'addEdge') {
    const edgeRaw =
      src.edge && typeof src.edge === 'object'
        ? src.edge
        : (() => {
            const { op: _o, action: _a, type: _t, edge: _e, ...rest } = src;
            return rest;
          })();
    const edge = normalizeAiEdge(edgeRaw);
    if (!edge.source || !edge.target) return null;
    return { op: 'addEdge', edge };
  }

  if (opName === 'updateNode') {
    const id = String(src.id ?? '');
    if (!id) return null;
    const changesRaw =
      src.changes && typeof src.changes === 'object'
        ? { ...(src.changes as Record<string, unknown>) }
        : (() => {
            const { op: _o, action: _a, type: _t, id: _i, changes: _c, ...rest } = src;
            return rest;
          })();
    delete changesRaw.id;
    if (changesRaw.w != null) {
      const w = Number(changesRaw.w);
      if (!Number.isFinite(w) || w <= 0) delete changesRaw.w;
      else changesRaw.w = w;
    }
    if (changesRaw.h != null) {
      const h = Number(changesRaw.h);
      if (!Number.isFinite(h) || h <= 0) delete changesRaw.h;
      else changesRaw.h = h;
    }
    for (const key of ['x', 'y'] as const) {
      if (changesRaw[key] != null) {
        const n = Number(changesRaw[key]);
        if (!Number.isFinite(n)) delete changesRaw[key];
        else changesRaw[key] = n;
      }
    }
    if (changesRaw.style) {
      const style = sanitizeNodeStyle(changesRaw.style);
      if (style) changesRaw.style = style;
      else delete changesRaw.style;
    }
    if (changesRaw.label != null) changesRaw.label = String(changesRaw.label);
    if (changesRaw.shape != null) changesRaw.shape = String(changesRaw.shape);
    return { op: 'updateNode', id, changes: changesRaw };
  }

  if (opName === 'updateEdge') {
    const id = String(src.id ?? '');
    if (!id) return null;
    const changesRaw =
      src.changes && typeof src.changes === 'object'
        ? { ...(src.changes as Record<string, unknown>) }
        : (() => {
            const { op: _o, action: _a, type: _t, id: _i, changes: _c, ...rest } = src;
            return rest;
          })();
    delete changesRaw.id;
    if (changesRaw.source != null) changesRaw.source = String(changesRaw.source || changesRaw.from || '');
    if (changesRaw.target != null) changesRaw.target = String(changesRaw.target || changesRaw.to || '');
    if (changesRaw.from != null) {
      changesRaw.source = String(changesRaw.from);
      delete changesRaw.from;
    }
    if (changesRaw.to != null) {
      changesRaw.target = String(changesRaw.to);
      delete changesRaw.to;
    }
    if (changesRaw.label != null) changesRaw.label = String(changesRaw.label);
    if (changesRaw.style) {
      const style = sanitizeEdgeStyle(changesRaw.style);
      if (style) changesRaw.style = style;
      else delete changesRaw.style;
    }
    return { op: 'updateEdge', id, changes: changesRaw };
  }

  if (opName === 'removeNode' || opName === 'removeEdge') {
    const id = String(src.id ?? '');
    if (!id) return null;
    return { op: opName, id };
  }

  if (opName === 'relabel') {
    const id = String(src.id ?? '');
    if (!id) return null;
    return { op: 'relabel', id, label: String(src.label ?? '') };
  }

  return null;
}

function parseAndValidateDocument(raw: string): DiagramDocument {
  const parsed = parseModelJson(raw);
  const normalized = normalizeAiDocument(parsed);
  return diagramDocumentSchema.parse(normalized);
}

function parseAndValidatePatches(raw: string): DiagramPatchOp[] {
  const parsed = parseModelJson(raw);
  const list = unwrapPatchOps(parsed);
  if (!list) {
    throw new AppError('AI returned an invalid patch payload', 422);
  }
  const ops: DiagramPatchOp[] = [];
  for (let i = 0; i < list.length; i++) {
    const normalized = normalizeAiPatchOp(list[i]);
    const result = diagramPatchOpSchema.safeParse(normalized);
    if (result.success) {
      ops.push(result.data);
    } else {
      logger.warn(
        { index: i, issues: result.error.issues.slice(0, 4), preview: JSON.stringify(list[i]).slice(0, 240) },
        'Diagram AI skipped invalid patch op'
      );
    }
  }
  if (!ops.length) {
    throw new AppError('AI returned an invalid patch payload', 422);
  }
  return ops;
}

function resolveEditResult(
  raw: string,
  current: DiagramPage
): { patch: DiagramPatchOp[]; page: DiagramPage } | null {
  // Prefer full page / document (primary edit contract).
  const asPage = tryParseAsEditedPage(raw, current);
  if (asPage && (asPage.nodes.length > 0 || current.nodes.length === 0)) {
    return { patch: [], page: asPage };
  }
  // Legacy / alternate: patch ops
  try {
    const patch = parseAndValidatePatches(raw);
    const page = diagramPageSchema.parse(applyPatches(current, patch));
    return { patch, page };
  } catch {
    /* fall through */
  }
  // Accept empty-ish page only if model clearly returned a page object
  if (asPage) return { patch: [], page: asPage };
  return null;
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

        let resolved = resolveEditResult(first.text, validatedPage);
        if (!resolved) {
          logger.warn(
            { userId, preview: first.text.slice(0, 500) },
            'Diagram AI edit first response invalid; repairing as page'
          );
          const repair = await provider.complete(
            [
              { role: 'system', content: REPAIR_PAGE_SYSTEM },
              {
                role: 'user',
                content: `Instruction: ${instruction}\n\nCurrent page:\n${JSON.stringify(slim)}\n\nBroken model output:\n${first.text.slice(0, 6000)}\n\nReturn the full corrected page JSON.`,
              },
            ],
            DIAGRAM_AI_REPAIR_OPTS
          );
          resolved = resolveEditResult(repair.text, validatedPage);
        }
        if (!resolved) {
          throw new AppError('AI could not update the diagram page. Try a simpler edit.', 422);
        }

        logger.info(
          {
            userId,
            model: env.AI_MODEL,
            ops: resolved.patch.length,
            nodes: resolved.page.nodes.length,
            edges: resolved.page.edges.length,
          },
          'Diagram AI edit'
        );
        return resolved;
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
