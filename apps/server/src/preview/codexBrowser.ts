import { PreviewTabId, type PreviewAutomationStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  readMcpProviderSession,
  type McpProviderSessionConfig,
} from "../mcp/McpProviderSession.ts";
import { resolveActiveMcpCredential } from "../mcp/McpSessionRegistry.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import { PreviewManager } from "./Manager.ts";
import { createCodexBrowserBackend } from "./codexBrowserBackend.ts";
import { listenBrowserPipe } from "./codexBrowserPipe.ts";
import packageJson from "../../package.json" with { type: "json" };
const isPreviewTabId = Schema.is(PreviewTabId);

class CodexBrowserUnavailableError extends Schema.TaggedError<CodexBrowserUnavailableError>()(
  "CodexBrowserUnavailableError",
  { message: Schema.String },
) {}

/** Opt-in interoperability with the user's installed, unchanged CUA plugin.
 * No bundled OpenAI runtime or plugin files are copied or modified. */
export const startCodexBrowser = Effect.fn("startCodexBrowser")(function* (input: {
  readonly nativeThreadId: string;
  readonly platform: string | null;
  readonly session: McpProviderSessionConfig;
  readonly broker: PreviewAutomationBroker["Service"];
  readonly preview: PreviewManager["Service"];
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);
  const authorize = Effect.gen(function* () {
    const current = readMcpProviderSession(input.session.threadId);
    const scope = yield* resolveActiveMcpCredential(
      input.session.authorizationHeader.replace(/^Bearer\s+/, ""),
    );
    if (
      !scope?.capabilities.has("preview") ||
      current?.providerSessionId !== input.session.providerSessionId ||
      scope.providerSessionId !== input.session.providerSessionId
    ) {
      return yield* new CodexBrowserUnavailableError({
        message:
          "Agent browser access was disabled or this provider session ended. Start a new turn after enabling browser access.",
      });
    }
    return scope;
  });
  const scope = yield* authorize;
  const backend = createCodexBrowserBackend({
    nativeThreadId: input.nativeThreadId,
    version: packageJson.version,
    host: {
      list: () =>
        runPromise(input.preview.list({ threadId: scope.threadId })).then((result) =>
          result.sessions.map((tab) => ({
            tabId: tab.tabId,
            url: tab.navStatus._tag === "Idle" ? null : tab.navStatus.url,
            title: tab.navStatus._tag === "Idle" ? null : tab.navStatus.title,
          })),
        ),
      open: async (visible, tabId, signal) => {
        const result = await runPromise(
          input.broker.invoke<PreviewAutomationStatus>({
            scope,
            operation: "open",
            input: { open: visible, reuseExistingTab: tabId !== undefined },
            ...(tabId ? { tabId } : {}),
          }),
          { signal },
        );
        if (!isPreviewTabId(result.tabId)) throw new Error("T3 Preview did not return a tab.");
        return { tabId: result.tabId, title: result.title, url: result.url };
      },
      close: (tabId) => runPromise(input.preview.close({ threadId: scope.threadId, tabId })),
      cdp: (tabId, cdpInput, signal) =>
        runPromise(
          input.broker.invoke({
            scope,
            operation: "browserCdp",
            input: cdpInput,
            tabId,
          }),
          { signal },
        ),
    },
  });
  if (input.platform !== "darwin" && input.platform !== "linux")
    return yield* new CodexBrowserUnavailableError({
      message: "Codex Preview currently requires a Unix host.",
    });
  const directory = "/tmp/codex-browser-use";
  yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 });
  const path = `${directory}/t3-preview-${yield* crypto.randomUUIDv4}.sock`;
  const pipe = yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      listenBrowserPipe({
        path,
        dispatch: async (method, params, peer) => {
          // Cleanup must remain possible after revocation. Every operation that
          // reads or changes the page revalidates the original credential.
          if (method !== "detach" && method !== "turnEnded") await runPromise(authorize);
          return backend.dispatch(method, params, peer);
        },
      }),
    ),
    (pipe) =>
      Effect.promise(async () => {
        await pipe.close();
        await backend.close();
      }),
  );
  yield* fileSystem.chmod(path, 0o600);
  yield* Effect.logInfo("Codex CUA connected to T3 Preview", {
    threadId: scope.threadId,
    socket: pipe.path,
  });
  return { release: (turnId?: string) => Effect.promise(() => backend.release(turnId)) };
});
