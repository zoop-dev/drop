import { DurableObject } from "cloudflare:workers";

export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<TransferRoom>;
  LOBBY: DurableObjectNamespace<LobbyRoom>;
  DB: D1Database;
}

export class TransferRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url = new URL(request.url);
    const peerId = crypto.randomUUID();
    const deviceName = url.searchParams.get("name") ?? "Device";
    const uaInfo = url.searchParams.get("ua") ?? "";
    const deviceId = url.searchParams.get("did") ?? "";

    const providedHash = url.searchParams.get("pwh") ?? "";
    const storedHash = await this.ctx.storage.get<string>("pwh") ?? null;
    if (storedHash !== null && storedHash !== providedHash) {
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      server.send(JSON.stringify({ type: "auth-error", reason: "wrong-password" }));
      server.close(4001, "Wrong password");
      return new Response(null, { status: 101, webSocket: client });
    }
    if (storedHash === null && providedHash) {
      await this.ctx.storage.put("pwh", providedHash);
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [peerId, deviceName, uaInfo, deviceId]);

    const existingPeers = this.ctx
      .getWebSockets()
      .filter((ws) => ws !== server)
      .map((ws) => { const [id, name, ua, did] = this.ctx.getTags(ws); return { id, name, ua, did }; });

    server.send(JSON.stringify({ type: "welcome", peerId, peers: existingPeers }));

    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== server) {
        ws.send(JSON.stringify({ type: "peer-joined", peerId, name: deviceName, ua: uaInfo, did: deviceId }));
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const [senderId] = this.ctx.getTags(ws);
    if (message instanceof ArrayBuffer) {
      if (message.byteLength < 16) return;
      const toId = bytesToUuid(new Uint8Array(message, 0, 16));
      const targets = this.ctx.getWebSockets(toId);
      if (!targets.length) return;
      const fromBytes = uuidToBytes(senderId);
      const rest = new Uint8Array(message, 16);
      const forwarded = new Uint8Array(16 + rest.byteLength);
      forwarded.set(fromBytes, 0);
      forwarded.set(rest, 16);
      for (const t of targets) t.send(forwarded.buffer);
      return;
    }
    let data: Record<string, unknown>;
    try { data = JSON.parse(message); } catch { return; }
    if (typeof data.to === "string") {
      for (const t of this.ctx.getWebSockets(data.to)) {
        t.send(JSON.stringify({ ...data, from: senderId }));
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const [peerId] = this.ctx.getTags(ws);
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) peer.send(JSON.stringify({ type: "peer-left", peerId }));
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const [peerId] = this.ctx.getTags(ws);
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) peer.send(JSON.stringify({ type: "peer-left", peerId }));
    }
  }
}

export class LobbyRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url = new URL(request.url);
    const peerId = crypto.randomUUID();
    const nickname = (url.searchParams.get("nickname") ?? "Anonymous").slice(0, 30);
    const subnet = (url.searchParams.get("subnet") ?? "").slice(0, 15);

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [peerId, nickname, subnet]);

    const peers = this.ctx
      .getWebSockets()
      .filter((ws) => ws !== server)
      .map((ws) => { const [id, nick, sub] = this.ctx.getTags(ws); return { id, nickname: nick, subnet: sub }; });

    server.send(JSON.stringify({ type: "lobby-welcome", peerId, peers }));

    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== server) {
        ws.send(JSON.stringify({ type: "lobby-peer-joined", peerId, nickname, subnet }));
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let data: Record<string, unknown>;
    try { data = JSON.parse(message); } catch { return; }
    const [senderId] = this.ctx.getTags(ws);
    if (typeof data.to === "string") {
      for (const t of this.ctx.getWebSockets(data.to)) {
        t.send(JSON.stringify({ ...data, from: senderId }));
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const [peerId] = this.ctx.getTags(ws);
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) peer.send(JSON.stringify({ type: "lobby-peer-left", peerId }));
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const [peerId] = this.ctx.getTags(ws);
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) peer.send(JSON.stringify({ type: "lobby-peer-left", peerId }));
    }
  }
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}
function bytesToUuid(b: Uint8Array): string {
  const h = Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes).map((b) => chars[b % chars.length]).join("");
}

function generateShareId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/room" && request.method === "POST") {
      return Response.json({ code: generateCode() });
    }

    if (url.pathname === "/api/share" && request.method === "POST") {
      const { data, iv, mime, filename, size } = await request.json() as Record<string, string>;
      if (!data || !iv || !mime) return new Response("Bad request", { status: 400 });
      if (data.length > 8_000_000) return new Response("Too large", { status: 413 });
      const id = generateShareId();
      const now = Date.now();
      await env.DB.prepare(
        "INSERT INTO shares (id, data, iv, mime, filename, size, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(id, data, iv, mime, filename ?? null, size ? parseInt(size) : null, now, now + 86_400_000).run();
      await env.DB.prepare("DELETE FROM shares WHERE expires_at < ?").bind(now).run();
      return Response.json({ id });
    }

    const shareGetMatch = url.pathname.match(/^\/api\/share\/([A-Za-z0-9_-]{10,16})$/);
    if (shareGetMatch) {
      if (request.method === "PATCH") {
        const { filename } = await request.json() as { filename?: string };
        if (!filename || typeof filename !== "string") return new Response("Bad request", { status: 400 });
        const result = await env.DB.prepare(
          "UPDATE shares SET filename = ? WHERE id = ? AND expires_at > ?"
        ).bind(filename.slice(0, 255), shareGetMatch[1], Date.now()).run();
        if (!result.meta.changes) return new Response("Not found or expired", { status: 404 });
        return Response.json({ ok: true });
      }
      const row = await env.DB.prepare(
        "SELECT data, iv, mime, filename, size FROM shares WHERE id = ? AND expires_at > ?"
      ).bind(shareGetMatch[1], Date.now()).first();
      if (!row) return new Response("Not found or expired", { status: 404 });
      await env.DB.prepare("DELETE FROM shares WHERE id = ?").bind(shareGetMatch[1]).run();
      return Response.json(row);
    }

    if (url.pathname === "/api/qr") {
      const data = url.searchParams.get("data");
      const size = /^\d{2,4}$/.test(url.searchParams.get("size") ?? "") ? url.searchParams.get("size") : "320";
      if (!data) return new Response("Bad request", { status: 400 });
      const res = await fetch(`https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&qzone=2&data=${encodeURIComponent(data)}`);
      if (!res.ok) return new Response("QR generation failed", { status: 502 });
      const h = new Headers(res.headers);
      h.set("Cache-Control", "public, max-age=86400");
      return new Response(res.body, { headers: h });
    }

    if (url.pathname === "/ws/lobby") {
      const id = env.LOBBY.idFromName("global");
      return env.LOBBY.get(id).fetch(request);
    }

    if (url.pathname.startsWith("/ws/")) {
      const code = url.pathname.slice(4).split("?")[0].toUpperCase();
      if (!code) return new Response("Bad request", { status: 400 });
      return env.ROOMS.getByName(code).fetch(request);
    }

    if (url.pathname === '/share-target' && request.method === 'POST') {
      return Response.redirect('/?incoming=share', 303);
    }

    if (/^\/share\/[A-Za-z0-9_-]{10,16}$/.test(url.pathname)) {
      const rootReq = new Request(new URL('/', request.url).toString());
      const res = await env.ASSETS.fetch(rootReq);
      const h = new Headers(res.headers);
      h.set('Cache-Control', 'no-store');
      return new Response(res.body, { status: res.status, headers: h });
    }

    if (/^\/room\/[A-Z0-9]{6}$/i.test(url.pathname)) {
      const rootReq = new Request(new URL('/', request.url).toString());
      const res = await env.ASSETS.fetch(rootReq);
      const h = new Headers(res.headers);
      h.set('Cache-Control', 'no-store');
      return new Response(res.body, { status: res.status, headers: h });
    }

    const res = await env.ASSETS.fetch(request);
    const ct = res.headers.get('Content-Type') ?? '';
    if (ct.includes('text/html')) {
      const h = new Headers(res.headers);
      h.set('Cache-Control', 'no-store');
      return new Response(res.body, { status: res.status, headers: h });
    }
    return res;
  },
};
