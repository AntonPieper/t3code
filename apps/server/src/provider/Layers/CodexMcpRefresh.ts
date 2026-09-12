import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";

const encodeConfiguration = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Compare only tool registration/capability settings; credentials stay in memory and are never logged. */
export const makeCodexMcpRefresh = Effect.fn("makeCodexMcpRefresh")(function* <E>(input: {
  readonly configuration: Effect.Effect<Readonly<Record<string, unknown>>, E>;
  readonly reload: Effect.Effect<unknown, E>;
}) {
  const read = input.configuration.pipe(
    Effect.map((config) =>
      encodeConfiguration({
        mcp: config.mcp_servers,
        plugins: config.plugins,
        apps: config.apps,
        features: config.features,
        credentialStore: config.mcp_oauth_credentials_store,
      }),
    ),
  );
  const failed = Effect.logWarning(
    "Codex MCP configuration refresh failed; continuing with the current tools and retrying next turn.",
  );
  let previous = yield* read.pipe(Effect.catch(() => failed.pipe(Effect.as(undefined))));
  const semaphore = yield* Semaphore.make(1);
  const refresh = Effect.fn("CodexSessionRuntime.refreshMcp")(
    function* (force: boolean) {
      const current = yield* read;
      if (!force && current === previous) return true;
      // Commit the fingerprint only after native refresh succeeds, so failure is retryable.
      yield* input.reload;
      previous = current;
      return true;
    },
    Effect.catch(() => failed.pipe(Effect.as(false))),
  );
  return (force = false) => semaphore.withPermit(refresh(force));
});
