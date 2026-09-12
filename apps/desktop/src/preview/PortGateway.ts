// @effect-diagnostics nodeBuiltinImport:off - The loopback transport preserves Node stream backpressure and raw WebSocket upgrade sockets.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import type * as NodeNet from "node:net";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import type { DesktopPreviewPortGatewayInput } from "@t3tools/contracts";

const ResponseHeaders = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
);
const decodeHeaders = Schema.decodeUnknownSync(Schema.fromJsonString(ResponseHeaders));
interface Proxy {
  input: DesktopPreviewPortGatewayInput;
  readonly origin: string;
  readonly server: NodeHttp.Server;
  readonly sockets: Set<NodeNet.Socket>;
  close(): Promise<void>;
}

/** Each guest gets its own local origin. Only bytes cross the authenticated environment route. */
export function makePreviewPortGateways(currentTimeMillis: () => number) {
  const proxies = new Map<string, Proxy>();
  const queues = new Map<string, Promise<unknown>>();
  const schedule = <A>(tabId: string, run: () => Promise<A>): Promise<A> => {
    const task = (queues.get(tabId) ?? Promise.resolve()).catch(() => undefined).then(run);
    queues.set(tabId, task);
    const complete = () => {
      if (queues.get(tabId) === task) queues.delete(tabId);
    };
    void task.then(complete, complete);
    return task;
  };
  const release = async (tabId: string) => {
    const proxy = proxies.get(tabId);
    if (!proxy) return;
    proxies.delete(tabId);
    await proxy.close();
  };
  const open = async (input: DesktopPreviewPortGatewayInput): Promise<string> => {
    const remote = new URL(input.gatewayUrl);
    if (
      !["http:", "https:"].includes(remote.protocol) ||
      remote.username ||
      remote.password ||
      !remote.pathname.startsWith("/api/preview-port/")
    )
      throw new Error("Invalid environment preview gateway.");
    const previous = proxies.get(input.tabId);
    if (
      previous &&
      previous.input.environmentId === input.environmentId &&
      previous.input.port === input.port &&
      previous.input.protocol === input.protocol
    ) {
      previous.input = input;
      return previous.origin;
    }
    if (previous) await release(input.tabId);
    let proxy: Proxy;
    const sockets = new Set<NodeNet.Socket>();
    const upstream = (request: NodeHttp.IncomingMessage) => {
      if (!request.url?.startsWith("/") || request.headers.host !== new URL(proxy.origin).host)
        throw new Error("Invalid preview host or path.");
      if (proxy.input.expiresAt <= currentTimeMillis())
        throw new Error("Preview authorization expired. Navigate again to reconnect.");
      const url = new URL(proxy.input.gatewayUrl);
      const requested = new URL(request.url, proxy.origin);
      url.pathname += requested.pathname.slice(1);
      url.search = requested.search;
      const headers = { ...request.headers };
      if (headers.authorization) headers["x-t3-preview-authorization"] = headers.authorization;
      delete headers.host;
      delete headers.authorization;
      delete headers["proxy-authorization"];
      const targetOrigin = `${proxy.input.protocol}://localhost:${proxy.input.port}`;
      if (headers.origin === proxy.origin) headers.origin = targetOrigin;
      if (headers.referer?.startsWith(`${proxy.origin}/`))
        headers.referer = targetOrigin + headers.referer.slice(proxy.origin.length);
      return (url.protocol === "https:" ? NodeHttps : NodeHttp).request(url, {
        method: request.method,
        headers,
      });
    };
    const server = NodeHttp.createServer((request, response) => {
      let outgoing: NodeHttp.ClientRequest;
      try {
        outgoing = upstream(request);
      } catch (cause) {
        response.writeHead(502);
        response.end(cause instanceof Error ? cause.message : "Preview connection failed.");
        return;
      }
      outgoing.on("response", (incoming) => {
        try {
          const encoded = incoming.headers["x-t3-preview-headers"];
          const status = Number(incoming.headers["x-t3-preview-status"]);
          if (
            typeof encoded !== "string" ||
            !Number.isInteger(status) ||
            status < 100 ||
            status > 599
          )
            throw new Error(
              "Preview connection expired or is unavailable. Navigate again to reconnect.",
            );
          const decoded = decodeHeaders(Buffer.from(encoded, "base64url").toString("utf8"));
          const headers = Object.fromEntries(
            Object.entries(decoded).map(([key, value]) => [
              key,
              typeof value === "string" ? value : [...value],
            ]),
          );
          // A loopback app cookie belongs only to this guest, even when the app
          // explicitly declares Domain=localhost. Ports do not isolate cookies.
          if (headers["set-cookie"]) {
            const cookies = headers["set-cookie"];
            headers["set-cookie"] = (typeof cookies === "string" ? [cookies] : cookies).map(
              (cookie) => cookie.replace(/;\s*domain=[^;]*/gi, ""),
            );
          }
          const location = headers.location;
          const targetOrigin = `${proxy.input.protocol}://localhost:${proxy.input.port}`;
          if (
            typeof location === "string" &&
            new URL(location, targetOrigin).origin === targetOrigin
          ) {
            const target = new URL(location, targetOrigin);
            headers.location = proxy.origin + target.pathname + target.search + target.hash;
          }
          response.writeHead(status, headers);
          incoming.on("error", () => response.destroy());
          incoming.pipe(response);
        } catch (cause) {
          incoming.destroy();
          response.writeHead(502);
          response.end(cause instanceof Error ? cause.message : "Preview response failed.");
        }
      });
      outgoing.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end("Could not reach the environment preview.");
      });
      response.on("close", () => outgoing.destroy());
      request.on("error", () => outgoing.destroy());
      request.pipe(outgoing);
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("upgrade", (request, socket, head) => {
      let outgoing: NodeHttp.ClientRequest;
      try {
        outgoing = upstream(request);
      } catch {
        socket.destroy();
        return;
      }
      outgoing.on("upgrade", (response, upstreamSocket, upstreamHead) => {
        if (response.statusCode !== 101) {
          socket.destroy();
          upstreamSocket.destroy();
          return;
        }
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\n${response.rawHeaders.reduce((text, value, index, headers) => (index % 2 === 0 ? `${text}${value}: ${headers[index + 1]}\r\n` : text), "")}\r\n`,
        );
        if (head.length) upstreamSocket.write(head);
        if (upstreamHead.length) socket.write(upstreamHead);
        socket.pipe(upstreamSocket).pipe(socket);
        socket.on("close", () => upstreamSocket.destroy());
        upstreamSocket.on("error", () => socket.destroy());
        upstreamSocket.on("close", () => socket.destroy());
        socket.on("error", () => upstreamSocket.destroy());
      });
      outgoing.on("response", (response) => {
        response.destroy();
        socket.destroy();
      });
      outgoing.on("error", () => socket.destroy());
      socket.on("close", () => outgoing.destroy());
      outgoing.end();
    });
    const starting = new Promise<string>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          reject(new Error("Preview proxy did not bind a loopback port."));
          return;
        }
        server.removeListener("error", reject);
        server.on("error", () => {
          for (const socket of sockets) socket.destroy();
        });
        proxy = {
          input,
          origin: `http://preview-${NodeCrypto.randomUUID()}.localhost:${address.port}`,
          server,
          sockets,
          close: () =>
            new Promise<void>((done) => {
              for (const socket of sockets) socket.destroy();
              server.close(() => done());
            }),
        };
        proxies.set(input.tabId, proxy);
        resolve(proxy.origin);
      });
    });
    return await starting;
  };
  return {
    open: (input: DesktopPreviewPortGatewayInput) => schedule(input.tabId, () => open(input)),
    release: (tabId: string) => schedule(tabId, () => release(tabId)),
    close: async () => {
      await Promise.allSettled(queues.values());
      await Promise.all([...proxies.keys()].map(release));
    },
  };
}
