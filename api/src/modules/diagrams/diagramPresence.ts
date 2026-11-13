/**
 * In-memory presence for shared diagram edit links (poll-based).
 * Keys by share token; entries expire after TTL.
 */

export type PresencePeer = {
  clientId: string;
  name: string;
  color: string;
  x: number;
  y: number;
  selectionIds: string[];
  updatedAt: number;
};

const TTL_MS = 12_000;
const store = new Map<string, Map<string, PresencePeer>>();

const COLORS = ["#2563eb", "#dc2626", "#16a34a", "#ca8a04", "#9333ea", "#0891b2", "#ea580c"];

function colorFor(clientId: string): string {
  let h = 0;
  for (let i = 0; i < clientId.length; i++) h = (h * 31 + clientId.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length]!;
}

function prune(token: string) {
  const room = store.get(token);
  if (!room) return;
  const now = Date.now();
  for (const [id, peer] of room) {
    if (now - peer.updatedAt > TTL_MS) room.delete(id);
  }
  if (!room.size) store.delete(token);
}

export function upsertPresence(
  token: string,
  body: {
    clientId: string;
    name?: string;
    x: number;
    y: number;
    selectionIds?: string[];
  }
): PresencePeer[] {
  prune(token);
  let room = store.get(token);
  if (!room) {
    room = new Map();
    store.set(token, room);
  }
  const peer: PresencePeer = {
    clientId: body.clientId,
    name: (body.name || "Guest").slice(0, 40),
    color: colorFor(body.clientId),
    x: body.x,
    y: body.y,
    selectionIds: body.selectionIds ?? [],
    updatedAt: Date.now(),
  };
  room.set(body.clientId, peer);
  return listPresence(token, body.clientId);
}

export function listPresence(token: string, excludeClientId?: string): PresencePeer[] {
  prune(token);
  const room = store.get(token);
  if (!room) return [];
  return [...room.values()].filter((p) => p.clientId !== excludeClientId);
}

export function leavePresence(token: string, clientId: string) {
  const room = store.get(token);
  if (!room) return;
  room.delete(clientId);
  if (!room.size) store.delete(token);
}
