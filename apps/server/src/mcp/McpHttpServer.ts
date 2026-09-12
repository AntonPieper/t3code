import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { PreviewAutomationSnapshot, type PreviewAutomationSnapshotInput } from "@t3tools/contracts";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import {
  PreviewSnapshotToolkitHandlersLive,
  PreviewStandardToolkitHandlersLive,
} from "./toolkits/preview/handlers.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";
import { PullRequestsToolkitHandlersLive } from "./toolkits/pullRequests/handlers.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import {
  DeviceScreenshotToolkitHandlersLive,
  DeviceStandardToolkitHandlersLive,
} from "./toolkits/device/handlers.ts";
import {
  DeviceScreenshotTool,
  DeviceScreenshotToolkit,
  DeviceStandardToolkit,
} from "./toolkits/device/tools.ts";

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mcp_credential",
    message: "A valid provider-scoped MCP bearer credential is required.",
  },
  {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": "Bearer",
    },
  },
);

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

export const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const bodyIsEmpty =
    response.body._tag === "Empty" ||
    (response.body._tag === "Uint8Array" && response.body.contentLength === 0) ||
    (response.body._tag === "Raw" && response.body.contentLength === 0);
  return response.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(response, 202)
    : response;
};

const makeMcpAuthMiddleware = McpSessionRegistry.McpSessionRegistry.pipe(
  Effect.map((registry): McpAuthMiddleware =>
    Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const authorization = request.headers.authorization;
      const token =
        authorization?.startsWith("Bearer ") === true
          ? authorization.slice("Bearer ".length).trim()
          : "";
      const invocation = yield* registry.resolve(token);
      if (!invocation) {
        // Without this the only symptom of a dead credential is the agent
        // quietly losing the whole `t3-code` toolkit for the rest of its
        // session, with nothing on the server to explain why.
        yield* Effect.logWarning("rejected MCP request with an unusable credential", {
          reason: token.length === 0 ? "missing_bearer_token" : "unknown_or_expired_token",
        });
        return unauthorized;
      }
      return yield* httpEffect.pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.map(normalizeMcpHttpResponse),
      );
    }),
  ),
  Effect.withSpan("McpHttpServer.makeAuthMiddleware"),
);

const McpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware).layer;

/** The selected native representation, including omission notices, fits this budget. */
export const MAX_SNAPSHOT_TEXT_BYTES = 60_000;
const MAX_SNAPSHOT_VISIBLE_TEXT_CHARS = 8_000;
const MAX_SNAPSHOT_ELEMENT_NAME_CHARS = 200;
const MAX_SNAPSHOT_LOG_ENTRIES = 40;
const MAX_SNAPSHOT_LOG_TEXT_CHARS = 500;
const MAX_SNAPSHOT_IDENTIFIER_CHARS = 2_048;

const decodeSnapshot = Schema.decodeUnknownEffect(PreviewAutomationSnapshot);
const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const cutText = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** One value for direct consumers and native programmatic composition. Never truncate selectors. */
const boundSnapshotMetadata = (
  snapshot: PreviewAutomationSnapshot,
  input: PreviewAutomationSnapshotInput,
  artifacts: { readonly screenshotPath?: string; readonly evidencePath?: string },
) => {
  const omissions = (snapshot.omissions ?? []).slice(0, 10).map((value) => cutText(value, 500));
  const bounded: Record<string, unknown> = {
    url: cutText(snapshot.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    title: cutText(snapshot.title, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    loading: snapshot.loading,
    ...artifacts,
  };
  if (
    snapshot.url.length > MAX_SNAPSHOT_IDENTIFIER_CHARS ||
    snapshot.title.length > MAX_SNAPSHOT_IDENTIFIER_CHARS
  ) {
    omissions.push(`url or title after ${MAX_SNAPSHOT_IDENTIFIER_CHARS} characters`);
  }
  if (snapshot.accessibilityTree !== undefined && input.includeText !== false) {
    omissions.push("accessibilityTree (see evidencePath, or use save=true for full evidence)");
  }
  const lists: Record<string, ReadonlyArray<unknown>> = {};
  if (input.includeText !== false) {
    const visibleText = snapshot.visibleText ?? "";
    bounded.visibleText = cutText(visibleText, MAX_SNAPSHOT_VISIBLE_TEXT_CHARS);
    if (visibleText.length > MAX_SNAPSHOT_VISIBLE_TEXT_CHARS) {
      omissions.push(
        `visibleText after ${MAX_SNAPSHOT_VISIBLE_TEXT_CHARS} characters (save=true for full evidence)`,
      );
    }
    const elements = snapshot.interactiveElements ?? [];
    if (elements.some((element) => element.name.length > MAX_SNAPSHOT_ELEMENT_NAME_CHARS)) {
      omissions.push(`element names longer than ${MAX_SNAPSHOT_ELEMENT_NAME_CHARS} characters`);
    }
    const usable = elements.filter(
      (element) => Buffer.byteLength(element.selector, "utf8") <= 8_192,
    );
    if (usable.length < elements.length)
      omissions.push(
        `${elements.length - usable.length} oversized selectors (save=true for full evidence)`,
      );
    lists.interactiveElements = usable.map((element) => ({
      ...element,
      tag: cutText(element.tag, 200),
      role: element.role === null ? null : cutText(element.role, 200),
      name: cutText(element.name, MAX_SNAPSHOT_ELEMENT_NAME_CHARS),
    }));
  }
  for (const [selection, key, label] of [
    ["console", "consoleEntries", "console entries"],
    ["network", "networkEntries", "network entries"],
    ["actions", "actionTimeline", "action timeline entries"],
  ] as const) {
    if (!input.diagnostics?.includes(selection)) continue;
    const entries = snapshot[key] ?? [];
    if (entries.length > MAX_SNAPSHOT_LOG_ENTRIES)
      omissions.push(`${entries.length - MAX_SNAPSHOT_LOG_ENTRIES} older ${label}`);
    const kept = entries.slice(-MAX_SNAPSHOT_LOG_ENTRIES);
    if (
      kept.some((entry) =>
        Object.values(entry).some(
          (value) => typeof value === "string" && value.length > MAX_SNAPSHOT_LOG_TEXT_CHARS,
        ),
      )
    ) {
      omissions.push(`${label} text after ${MAX_SNAPSHOT_LOG_TEXT_CHARS} characters`);
    }
    lists[key] = kept.map((entry) =>
      Object.fromEntries(
        Object.entries(entry).map(([key, value]) => [
          key,
          typeof value === "string" ? cutText(value, MAX_SNAPSHOT_LOG_TEXT_CHARS) : value,
        ]),
      ),
    );
  }
  if (snapshot.screenshot && (input.includeImage !== false || input.save)) {
    const { data: _data, ...image } = snapshot.screenshot;
    bounded.screenshot = image;
  }
  const dropped = new Map<string, number>();
  const value = () => ({
    ...bounded,
    ...lists,
    omissions: [
      ...omissions,
      ...Array.from(
        dropped,
        ([key, count]) =>
          `${count} ${key} omitted to fit observation (save=true for full evidence)`,
      ),
    ],
  });
  let result = value();
  let text = encodeJsonText(result);
  while (Buffer.byteLength(text, "utf8") > MAX_SNAPSHOT_TEXT_BYTES) {
    const key = ["actionTimeline", "networkEntries", "consoleEntries", "interactiveElements"].find(
      (key) => (lists[key]?.length ?? 0) > 0,
    );
    if (!key) {
      // JSON escaping can expand one input character into six output bytes.
      // Preserve identity and omission notices while shortening free-form page text.
      const field = ["visibleText", "title", "url"].find(
        (field) => typeof bounded[field] === "string" && bounded[field].length > 128,
      );
      if (!field) throw new Error("Preview metadata could not fit the observation budget.");
      const previous = String(bounded[field]);
      bounded[field] = cutText(previous, Math.floor(previous.length / 2));
      if (!dropped.has(field)) dropped.set(field, 0);
      dropped.set(field, dropped.get(field)! + previous.length - String(bounded[field]).length);
      result = value();
      text = encodeJsonText(result);
      continue;
    }
    const entries = lists[key]!;
    const keep = Math.floor(entries.length / 2);
    dropped.set(key, (dropped.get(key) ?? 0) + entries.length - keep);
    lists[key] =
      keep === 0
        ? []
        : key === "interactiveElements"
          ? entries.slice(0, keep)
          : entries.slice(-keep);
    result = value();
    text = encodeJsonText(result);
  }
  return { value: result, text };
};

export class PreviewScreenshotSaveError extends Schema.TaggedError<PreviewScreenshotSaveError>()(
  "PreviewScreenshotSaveError",
  { screenshotPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not save preview screenshot to ${this.screenshotPath}.`;
  }
}

class PreviewSnapshotComponentError extends Schema.TaggedError<PreviewSnapshotComponentError>()(
  "PreviewSnapshotComponentError",
  { component: Schema.String },
) {
  override get message() {
    return `The Preview host omitted the requested ${this.component}. Reconnect or update the hosting desktop and retry.`;
  }
}

const MAX_SCREENSHOT_SITE_SLUG_LENGTH = 40;

/** Hostname reduced to a filename-safe slug, matching the desktop's own screenshot names. */
const screenshotSiteSlug = (rawUrl: string): string => {
  try {
    const slug = new URL(rawUrl).hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SCREENSHOT_SITE_SLUG_LENGTH)
      .replace(/-+$/g, "");
    return slug || "site";
  } catch {
    return "site";
  }
};

/** Writes the snapshot PNG under the browser artifacts directory and returns its path. */
const saveScreenshot = Effect.fn("McpHttpServer.saveScreenshot")(function* (
  pageUrl: string,
  data: Uint8Array,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const millis = yield* Clock.currentTimeMillis;
  // Two saves in the same millisecond must not overwrite each other.
  const fileName = `browser-screenshot-${screenshotSiteSlug(pageUrl)}-${millis.toString(36)}-${NodeCrypto.randomUUID().slice(0, 8)}.png`;
  const screenshotPath = path.join(config.browserArtifactsDir, fileName);
  yield* fileSystem.makeDirectory(config.browserArtifactsDir, { recursive: true }).pipe(
    Effect.andThen(fileSystem.writeFile(screenshotPath, data)),
    Effect.mapError((cause) => new PreviewScreenshotSaveError({ screenshotPath, cause })),
  );
  return screenshotPath;
});

const previewSnapshotFailure = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }
  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0]?.error;
  const errorTag =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "_tag" in firstFailure &&
    typeof firstFailure._tag === "string"
      ? firstFailure._tag
      : "PreviewSnapshotError";
  const message =
    firstFailure instanceof Error
      ? cutText(firstFailure.message, 2_000)
      : `Preview snapshot failed: ${errorTag}. Check the requested options and hosting desktop, then retry.`;
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: "snapshot",
        failureCount: failures.length,
        message,
      },
    },
    content: [
      {
        type: "text",
        text: encodeJsonText({
          error: { _tag: errorTag, operation: "snapshot", failureCount: failures.length, message },
        }),
      },
    ],
  });
  return Effect.logWarning("preview snapshot failed", {
    operation: "snapshot",
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
};

const registerPreviewSnapshot = Effect.fn("McpHttpServer.registerPreviewSnapshot")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  // The MCP tool runner only supplies the client, so hand the save path its services here.
  const saveServices = yield* Effect.context<
    ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path
  >();
  const built = yield* PreviewSnapshotToolkit;
  const tool = PreviewSnapshotTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return built.handle("preview_snapshot", payload).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.flatMap(({ encodedResult }) =>
            Effect.gen(function* () {
              const snapshot = yield* decodeSnapshot(encodedResult);
              const input = payload ?? {};
              const screenshot = snapshot.screenshot;
              const png =
                screenshot && (input.includeImage !== false || input.save === true)
                  ? new Uint8Array(Buffer.from(screenshot.data, "base64"))
                  : undefined;
              if (!png && (input.includeImage !== false || input.save === true)) {
                return yield* new PreviewSnapshotComponentError({ component: "screenshot" });
              }
              const screenshotPath =
                input.save === true && png ? yield* saveScreenshot(snapshot.url, png) : undefined;
              const evidencePath = screenshotPath?.replace(/\.png$/, ".json");
              if (evidencePath) {
                const fileSystem = yield* FileSystem.FileSystem;
                const { screenshot: _screenshot, ...page } = snapshot;
                yield* fileSystem
                  .writeFileString(evidencePath, encodeJsonText({ ...page, screenshotPath }))
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new PreviewScreenshotSaveError({ screenshotPath: evidencePath, cause }),
                    ),
                  );
              }
              const bounded = boundSnapshotMetadata(snapshot, input, {
                ...(screenshotPath === undefined ? {} : { screenshotPath }),
                ...(evidencePath === undefined ? {} : { evidencePath }),
              });
              const includeImage = input.includeImage !== false && png !== undefined;
              return new McpSchema.CallToolResult({
                isError: false,
                // Direct Codex selects structuredContent instead of content, including its images.
                ...(includeImage ? {} : { structuredContent: bounded.value }),
                content: [
                  // URL stays first in the bounded observation for native website icons.
                  { type: "text", text: bounded.text },
                  ...(includeImage
                    ? [{ type: "image" as const, data: png, mimeType: "image/png" }]
                    : []),
                ],
              });
            }),
          ),
          Effect.provide(saveServices),
          Effect.matchCauseEffect({
            onFailure: previewSnapshotFailure,
            onSuccess: Effect.succeed,
          }),
        );
      }),
  });
});

interface ImageToolResult {
  readonly screenshot: {
    readonly mimeType: "image/png";
    readonly data: string;
    readonly width: number;
    readonly height: number;
  };
  readonly [key: string]: unknown;
}

/**
 * Failures surface only their tag: the remote message may carry renderer or
 * device output the agent should not see, and the tag is what it can act on.
 */
const imageToolFailure =
  (toolName: string, operation: string, failureText: string) =>
  <E>(cause: Cause.Cause<E>) => {
    if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
      return Effect.failCause(cause).pipe(Effect.orDie);
    }
    const failures = cause.reasons.filter(Cause.isFailReason);
    const firstFailure = failures[0]?.error;
    const errorTag =
      typeof firstFailure === "object" &&
      firstFailure !== null &&
      "_tag" in firstFailure &&
      typeof firstFailure._tag === "string"
        ? firstFailure._tag
        : `${toolName}Error`;
    const result = new McpSchema.CallToolResult({
      isError: true,
      structuredContent: {
        error: {
          _tag: errorTag,
          operation,
          failureCount: failures.length,
        },
      },
      content: [{ type: "text", text: failureText }],
    });
    return Effect.logWarning(`${toolName} failed`, {
      operation,
      errorTag,
      failureCount: failures.length,
    }).pipe(Effect.as(result));
  };

/**
 * `McpServer.toolkit` serializes every result as JSON text, which is the
 * wrong shape for a screenshot: the model needs image content. Tools whose
 * result carries a `screenshot` field are registered by hand so the PNG goes
 * out as an image block and the rest of the payload as JSON metadata.
 */
const registerImageTool = <T extends Tool.Any, E, R>(
  tool: T,
  handle: (payload: Tool.Parameters<T>) => Effect.Effect<{ readonly encodedResult: unknown }, E, R>,
  provide: (
    effect: Effect.Effect<{ readonly encodedResult: unknown }, E, R>,
  ) => Effect.Effect<
    { readonly encodedResult: unknown },
    E,
    McpInvocationContext.McpInvocationContext
  >,
  operation: string,
  failureText: string,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: tool.name,
        description: Tool.getDescription(tool),
        inputSchema: Tool.getJsonSchema(tool),
        annotations: {
          ...Context.getOption(tool.annotations, Tool.Title).pipe(
            Option.map((title) => ({ title })),
            Option.getOrUndefined,
          ),
          readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
          destructiveHint: Context.get(tool.annotations, Tool.Destructive),
          idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
          openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
        },
      }),
      annotations: tool.annotations,
      handle: (payload) =>
        Effect.withFiber((fiber) => {
          const invocation = Context.getUnsafe(
            fiber.context,
            McpInvocationContext.McpInvocationContext,
          );
          return provide(handle(payload as Tool.Parameters<T>)).pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.matchCauseEffect({
              onFailure: imageToolFailure(tool.name, operation, failureText),
              onSuccess: ({ encodedResult }) => {
                const { screenshot, ...rest } = encodedResult as ImageToolResult;
                const includeImage =
                  (payload as { readonly includeImage?: boolean } | undefined)?.includeImage !==
                  false;
                const metadata = {
                  ...rest,
                  screenshot: {
                    mimeType: screenshot.mimeType,
                    width: screenshot.width,
                    height: screenshot.height,
                  },
                };
                return Effect.succeed(
                  new McpSchema.CallToolResult({
                    isError: false,
                    structuredContent: metadata,
                    content: [
                      { type: "text", text: JSON.stringify(metadata) },
                      ...(includeImage
                        ? [
                            {
                              type: "image" as const,
                              data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
                              mimeType: screenshot.mimeType,
                            },
                          ]
                        : []),
                    ],
                  }),
                );
              },
            }),
          );
        }),
    });
  });

const registerDeviceScreenshot = Effect.fn("McpHttpServer.registerDeviceScreenshot")(function* () {
  const devices = yield* DeviceService.DeviceService;
  const built = yield* DeviceScreenshotToolkit;
  yield* registerImageTool(
    DeviceScreenshotTool,
    (payload) =>
      built
        .handle("device_screenshot", payload)
        .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption)),
    (effect) => effect.pipe(Effect.provideService(DeviceService.DeviceService, devices)),
    "screenshot",
    "Device screenshot failed.",
  );
});

const PreviewStandardToolkitRegistrationLive = McpServer.toolkit(PreviewStandardToolkit).pipe(
  Layer.provide(PreviewStandardToolkitHandlersLive),
);

const PreviewSnapshotRegistrationLive = Layer.effectDiscard(registerPreviewSnapshot()).pipe(
  Layer.provide(PreviewSnapshotToolkitHandlersLive),
);

export const PreviewToolkitRegistrationLive = Layer.mergeAll(
  PreviewStandardToolkitRegistrationLive,
  PreviewSnapshotRegistrationLive,
);

export const PullRequestsToolkitRegistrationLive = McpServer.toolkit(PullRequestsToolkit).pipe(
  Layer.provide(PullRequestsToolkitHandlersLive),
);

const DeviceStandardToolkitRegistrationLive = McpServer.toolkit(DeviceStandardToolkit).pipe(
  Layer.provide(DeviceStandardToolkitHandlersLive),
);

const DeviceScreenshotRegistrationLive = Layer.effectDiscard(registerDeviceScreenshot()).pipe(
  Layer.provide(DeviceScreenshotToolkitHandlersLive),
);

export const DeviceToolkitRegistrationLive = Layer.mergeAll(
  DeviceStandardToolkitRegistrationLive,
  DeviceScreenshotRegistrationLive,
);

const McpTransportLive = McpServer.layerHttp({
  name: "T3 Code",
  version: packageJson.version,
  path: "/mcp",
  protocols: [McpProtocol.v2025_06_18],
}).pipe(Layer.provide(McpAuthMiddlewareLive));

export const layer = Layer.mergeAll(
  PreviewToolkitRegistrationLive,
  PullRequestsToolkitRegistrationLive,
  DeviceToolkitRegistrationLive,
).pipe(Layer.provideMerge(McpTransportLive));
