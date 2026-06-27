import { DurableObject } from "cloudflare:workers";

export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<TransferRoom>;
  LOBBY: DurableObjectNamespace<LobbyRoom>;
}

export class TransferRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url = new URL(request.url);
    const peerId = crypto.randomUUID();
    const deviceName = url.searchParams.get("name") ?? "Device";

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [peerId, deviceName]);

    const existingPeers = this.ctx
      .getWebSockets()
      .filter((ws) => ws !== server)
      .map((ws) => { const [id, name] = this.ctx.getTags(ws); return { id, name }; });

    server.send(JSON.stringify({ type: "welcome", peerId, peers: existingPeers }));

    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== server) {
        ws.send(JSON.stringify({ type: "peer-joined", peerId, name: deviceName }));
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

function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes).map((b) => chars[b % chars.length]).join("");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/room" && request.method === "POST") {
      return Response.json({ code: generateCode() });
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
