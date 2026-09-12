// @effect-diagnostics globalFetchInEffect:off nodeBuiltinImport:off - This test drives the real HTTP and WebSocket transport across two owned loopback servers.
import { expect, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import * as NodeHttp from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import {
  createPortGatewayGrant,
  resolvePortGatewayGrant,
  previewUpstreamHeaders,
  layer,
} from "./PortGateway.ts";
import { makePreviewPortGateways } from "../../../desktop/src/preview/PortGateway.ts";

// Exercise Chromium's synthetic localhost origin through an owned loopback socket.
const proxyFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; redirect?: "manual" },
) =>
  new Promise<Response>((resolve, reject) => {
    const target = new URL(url);
    const request = NodeHttp.request(
      {
        hostname: "127.0.0.1",
        port: target.port,
        path: target.pathname + target.search,
        method: init?.method,
        headers: { ...init?.headers, host: target.host },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("error", reject);
        incoming.on("end", () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (value === undefined) continue;
            for (const entry of typeof value === "string" ? [value] : value)
              headers.append(key, entry);
          }
          resolve(
            new Response(
              incoming.statusCode === 204 || incoming.statusCode === 304 || init?.method === "HEAD"
                ? null
                : Buffer.concat(chunks),
              { status: incoming.statusCode ?? 500, headers },
            ),
          );
        });
      },
    );
    request.on("error", reject);
    request.end(init?.body);
  });

const secretLayer = Layer.mock(ServerSecretStore)({
  getOrCreateRandom: () => Effect.succeed(new TextEncoder().encode("preview-fixture-secret")),
});
const testLayer = NodeHttpServer.layerTest.pipe(
  Layer.provideMerge(secretLayer),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "proxies root assets, POSTs, cookies, redirects and WebSockets on separate desktop origins",
  () =>
    Effect.gen(function* () {
      const received: Array<{
        path: string;
        authorization?: string;
        cookie?: string;
        origin?: string;
      }> = [];
      const upstream = NodeHttp.createServer(async (request, response) => {
        received.push({
          path: request.url ?? "",
          ...(request.headers.authorization
            ? { authorization: request.headers.authorization }
            : {}),
          ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
          ...(request.headers.origin ? { origin: request.headers.origin } : {}),
        });
        if (request.url === "/cached" || request.url === "/empty") {
          response.writeHead(request.url === "/cached" ? 304 : 204, { etag: "fixture-version" });
          response.end();
          return;
        }
        if (request.url === "/redirect") {
          response.writeHead(302, { location: "/nested/page" });
          response.end();
          return;
        }
        if (request.url === "/root.js") {
          response.writeHead(200, { "content-type": "text/javascript" });
          response.end("window.fixture = true");
          return;
        }
        if (request.method === "POST") {
          response.writeHead(201, { "content-type": "text/plain" });
          request.pipe(response);
          return;
        }
        response.writeHead(200, {
          "content-type": "text/html",
          "set-cookie": ["one=1; Path=/; Domain=localhost", "two=2; Path=/"],
        });
        response.end('<!doctype html><script src="/root.js"></script><h1>Gateway fixture</h1>');
      });
      const wss = new WebSocketServer({ noServer: true });
      upstream.on("upgrade", (request, socket, head) =>
        wss.handleUpgrade(request, socket, head, (peer) =>
          peer.on("message", (bytes, binary) => peer.send(bytes, { binary })),
        ),
      );
      yield* Effect.acquireRelease(
        Effect.promise(
          () => new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve)),
        ),
        () =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                for (const peer of wss.clients) peer.terminate();
                wss.close();
                upstream.closeAllConnections();
                upstream.close(() => resolve());
              }),
          ),
      );
      const address = upstream.address();
      if (!address || typeof address === "string") return yield* Effect.die("Fixture did not bind");
      yield* HttpRouter.serve(layer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const app = yield* HttpServer.HttpServer;
      if (app.address._tag !== "TcpAddress") return yield* Effect.die("Gateway did not bind");
      const grant = yield* createPortGatewayGrant({ port: address.port });
      const initialResponse = yield* (yield* HttpClient.HttpClient).get(grant.relativeUrl);
      expect(initialResponse.status, yield* initialResponse.text).toBe(200);
      const gatewayUrl = `http://127.0.0.1:${app.address.port}${grant.relativeUrl}`;
      const clock = yield* Clock.Clock;
      const proxies = yield* Effect.acquireRelease(
        Effect.sync(() => makePreviewPortGateways(() => clock.currentTimeMillisUnsafe())),
        (proxies) => Effect.promise(proxies.close),
      );
      const input = {
        tabId: "first-tab",
        environmentId: EnvironmentId.make("remote-environment"),
        protocol: "http" as const,
        port: address.port,
        gatewayUrl,
        expiresAt: grant.expiresAt,
      };
      const first = yield* Effect.promise(() => proxies.open(input));
      expect(yield* Effect.promise(() => proxies.open(input))).toBe(first);
      const second = yield* Effect.promise(() => proxies.open({ ...input, tabId: "second-tab" }));
      expect(new URL(second).hostname).not.toBe(new URL(first).hostname);
      expect(
        yield* Effect.tryPromise(() => proxies.open({ ...input, gatewayUrl: "file:///bad" })).pipe(
          Effect.isFailure,
        ),
      ).toBe(true);
      const document = yield* Effect.promise(() => proxyFetch(`${first}/`));
      expect(document.status, yield* Effect.promise(() => document.clone().text())).toBe(200);
      expect(document.headers.get("content-type")).toBe("text/html");
      expect(document.headers.getSetCookie()).toEqual(["one=1; Path=/", "two=2; Path=/"]);
      expect(yield* Effect.promise(() => document.text())).toContain("Gateway fixture");
      expect(
        yield* Effect.promise(() =>
          proxyFetch(`${first}/root.js`).then((response) => response.text()),
        ),
      ).toBe("window.fixture = true");
      const post = yield* Effect.promise(() =>
        proxyFetch(`${first}/api?query=kept`, {
          method: "POST",
          body: "kept body",
          headers: {
            authorization: "Bearer application-only",
            cookie: "app=session; t3_session_fixture=never-forward",
            origin: first,
          },
        }),
      );
      expect(post.status).toBe(201);
      expect(yield* Effect.promise(() => post.text())).toBe("kept body");
      expect(received.at(-1)).toEqual({
        path: "/api?query=kept",
        authorization: "Bearer application-only",
        cookie: "app=session",
        origin: `http://localhost:${address.port}`,
      });
      const redirect = yield* Effect.promise(() =>
        proxyFetch(`${first}/redirect`, { redirect: "manual" }),
      );
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe(`${first}/nested/page`);
      for (const [path, status] of [
        ["/cached", 304],
        ["/empty", 204],
      ] as const) {
        const response = yield* Effect.promise(() => proxyFetch(first + path));
        expect(response.status).toBe(status);
        expect(yield* Effect.promise(() => response.text())).toBe("");
      }
      expect((yield* Effect.promise(() => proxyFetch(first, { method: "HEAD" }))).status).toBe(200);
      const echo = yield* Effect.tryPromise(
        () =>
          new Promise<string>((resolve, reject) => {
            const socket = new WebSocket(
              `ws://127.0.0.1:${new URL(first).port}/hmr?token=test`,
              "vite-hmr",
              { headers: { host: new URL(first).host } },
            );
            socket.on("open", () => socket.send("reload"));
            socket.on("error", reject);
            socket.on("message", (data) => {
              resolve(data.toString());
              socket.close();
            });
          }),
      );
      expect(echo).toBe("reload");
      const client = yield* HttpClient.HttpClient;
      const direct = yield* client.get(grant.relativeUrl);
      expect(direct.headers["content-type"]).toBe("application/octet-stream");
      expect(direct.headers["content-disposition"]).toBe("attachment");
      yield* Effect.promise(() => proxies.release("first-tab"));
      expect(yield* Effect.tryPromise(() => proxyFetch(first)).pipe(Effect.isFailure)).toBe(true);
      expect((yield* Effect.promise(() => proxyFetch(second))).status).toBe(200);
      // The desktop transport never forwards the app's authorization header. A
      // preview's own bearer travels explicitly, separately from environment auth.
      expect(
        previewUpstreamHeaders({
          authorization: "environment-secret",
          cookie: "t3_session_live=secret; own=ok",
        }),
      ).toEqual({ cookie: " own=ok" });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("rejects malformed, expired, tampered and self-targeted grants", () =>
  Effect.gen(function* () {
    const app = yield* HttpServer.HttpServer;
    if (app.address._tag !== "TcpAddress") return yield* Effect.die("Fixture did not bind");
    expect(
      (yield* createPortGatewayGrant({ port: app.address.port }).pipe(Effect.flip)).message,
    ).toContain("itself");
    const grant = yield* createPortGatewayGrant({ port: 54321 });
    const token = grant.relativeUrl.split("/")[3]!;
    expect((yield* resolvePortGatewayGrant(token))?.port).toBe(54321);
    expect(yield* resolvePortGatewayGrant(`${token}.extra`)).toBeUndefined();
    expect(yield* resolvePortGatewayGrant(token.slice(0, -1))).toBeUndefined();
    yield* TestClock.adjust(24 * 60 * 60 * 1000);
    expect(yield* resolvePortGatewayGrant(token)).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
