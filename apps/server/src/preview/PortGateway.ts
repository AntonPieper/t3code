import { PreviewPortGatewayError, type PreviewPortGatewayInput } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
import {
  Cookies,
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Layer from "effect/Layer";
import WebSocket from "ws";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";

export const PREVIEW_GATEWAY_PREFIX = "/api/preview-port";
const Claims = Schema.Struct({
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  protocol: Schema.Literals(["http", "https"]),
  expiresAt: Schema.Finite,
});
const ClaimsJson = Schema.fromJsonString(Claims);
const encode = Schema.encodeSync(ClaimsJson);
const encodeResponseHeaders = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  ),
);
const signingKey = Effect.flatMap(ServerSecretStore, (store) =>
  store.getOrCreateRandom("preview-port-signing-key", 32),
);
const ownPort = Effect.map(HttpServer.HttpServer, (server) =>
  server.address._tag === "TcpAddress" ? server.address.port : null,
);

/** The grant names one loopback port; issuing it requires an authenticated operate RPC. */
export const createPortGatewayGrant = Effect.fn("PreviewPortGateway.create")(function* (
  input: PreviewPortGatewayInput,
) {
  if (input.port === (yield* ownPort))
    return yield* new PreviewPortGatewayError({
      port: input.port,
      message: "The T3 server itself cannot be used as a preview target.",
    });
  const expiresAt = (yield* Clock.currentTimeMillis) + 24 * 60 * 60 * 1000;
  const payload = base64UrlEncode(
    encode({ port: input.port, protocol: input.protocol ?? "http", expiresAt }),
  );
  const key = yield* signingKey.pipe(
    Effect.mapError(
      (cause) =>
        new PreviewPortGatewayError({
          port: input.port,
          message: "Could not authorize the preview connection.",
          cause,
        }),
    ),
  );
  return {
    relativeUrl: `${PREVIEW_GATEWAY_PREFIX}/${payload}.${signPayload(payload, key)}/`,
    expiresAt,
  };
});

export const resolvePortGatewayGrant = Effect.fn("PreviewPortGateway.resolve")(function* (
  token: string,
) {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  const [payload, signature] = parts;
  const key = yield* signingKey.pipe(Effect.orElseSucceed(() => null));
  if (!key || !timingSafeEqualBase64Url(signature, signPayload(payload, key))) return undefined;
  const decoded = yield* Effect.try(() => base64UrlDecodeUtf8(payload)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ClaimsJson)),
    Effect.orElseSucceed(() => undefined),
  );
  if (
    !decoded ||
    decoded.expiresAt <= (yield* Clock.currentTimeMillis) ||
    decoded.port === (yield* ownPort)
  )
    return undefined;
  return decoded;
});

/** App authorization and transport headers never reach a preview application. */
export function previewUpstreamHeaders(headers: Readonly<Record<string, string | undefined>>) {
  const result: Record<string, string> = {};
  const excluded = new Set([
    "host",
    "authorization",
    "proxy-authorization",
    "connection",
    "upgrade",
    "content-length",
    "accept-encoding",
    "transfer-encoding",
    "x-forwarded-host",
    "x-forwarded-for",
    "x-forwarded-proto",
  ]);
  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      excluded.has(name) ||
      name.startsWith("sec-websocket-") ||
      name.startsWith("x-t3-") ||
      name === "dpop"
    )
      continue;
    if (name === "cookie") {
      const cookie = value
        .split(";")
        .filter(
          (part) => !part.trim().startsWith("t3_session") && !part.trim().startsWith("t3_pairing"),
        )
        .join(";");
      if (cookie) result.cookie = cookie;
    } else result[name] = value;
  }
  if (headers["x-t3-preview-authorization"])
    result.authorization = headers["x-t3-preview-authorization"];
  return result;
}

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const parsed = HttpServerRequest.toURL(request);
  if (Option.isNone(parsed)) return HttpServerResponse.empty({ status: 400 });
  const suffix = parsed.value.pathname.slice(PREVIEW_GATEWAY_PREFIX.length + 1);
  const separator = suffix.indexOf("/");
  if (separator < 0) return HttpServerResponse.empty({ status: 404 });
  const claims = yield* resolvePortGatewayGrant(suffix.slice(0, separator));
  if (!claims)
    return HttpServerResponse.text("Preview authorization expired. Navigate again to reconnect.", {
      status: 401,
    });
  const upstreamUrl = new URL(`${claims.protocol}://localhost:${claims.port}`);
  // Assign pathname instead of resolving against a base: //host and encoded
  // traversal must never turn the signed loopback capability into an open proxy.
  upstreamUrl.pathname = suffix.slice(separator);
  upstreamUrl.search = parsed.value.search;
  const headers = previewUpstreamHeaders(request.headers);
  if (request.headers.upgrade?.toLowerCase() === "websocket") {
    upstreamUrl.protocol = claims.protocol === "https" ? "wss:" : "ws:";
    const protocols = request.headers["sec-websocket-protocol"]
      ?.split(",")
      .map((value) => value.trim());
    const upstream = yield* Socket.makeWebSocket(upstreamUrl.href, {
      protocols,
      openTimeout: 10_000,
    }).pipe(
      // The installed Node ws implementation is the same constructor used by
      // platform-node, with forwarding headers added at this transport boundary.
      Effect.provideService(
        Socket.WebSocketConstructor,
        (url, protocol) =>
          new WebSocket(url, protocol, {
            headers,
            maxPayload: 16 * 1024 * 1024,
          }) as unknown as globalThis.WebSocket,
      ),
    );
    const downstream = yield* request.upgrade;
    const sendUpstream = yield* upstream.writer;
    const sendDownstream = yield* downstream.writer;
    yield* Effect.raceFirst(upstream.runRaw(sendDownstream), downstream.runRaw(sendUpstream));
    return HttpServerResponse.empty();
  }
  const client = yield* HttpClient.HttpClient;
  let outgoing = HttpClientRequest.make(request.method)(upstreamUrl.href, { headers });
  if (request.method !== "GET" && request.method !== "HEAD")
    outgoing = HttpClientRequest.bodyStream(outgoing, request.stream, {
      contentType: request.headers["content-type"],
    });
  const response = yield* client
    .execute(outgoing)
    .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
  const metadata: Record<string, string | ReadonlyArray<string>> = {};
  const responseExcluded = new Set([
    "connection",
    "transfer-encoding",
    "content-length",
    "content-encoding",
    "keep-alive",
  ]);
  for (const [name, value] of Object.entries(response.headers))
    if (!responseExcluded.has(name)) metadata[name] = value;
  const cookies = Cookies.toSetCookieHeaders(response.cookies);
  if (cookies.length) metadata["set-cookie"] = cookies;
  // This endpoint is a byte transport. Direct browser navigation must never
  // execute a dev page on the T3 application's authenticated origin.
  return HttpServerResponse.stream(
    request.method === "HEAD" || response.status === 204 || response.status === 304
      ? Stream.empty
      : response.stream,
    {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": "attachment",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        "x-t3-preview-status": String(response.status),
        "x-t3-preview-headers": base64UrlEncode(encodeResponseHeaders(metadata)),
      },
    },
  );
}).pipe(
  Effect.catch(() =>
    Effect.succeed(
      HttpServerResponse.text("Could not reach the environment preview port.", { status: 502 }),
    ),
  ),
);
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return HttpRouter.add(
      "*",
      `${PREVIEW_GATEWAY_PREFIX}/*`,
      handler.pipe(Effect.provideService(HttpClient.HttpClient, client)),
    );
  }),
).pipe(Layer.provide(Layer.fresh(FetchHttpClient.layer)));
