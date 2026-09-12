import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as CodexErrors from "effect-codex-app-server/errors";
import { makeCodexMcpRefresh } from "./CodexMcpRefresh.ts";

it.effect("reloads only changed registrations or explicit refresh and retries failures", () =>
  Effect.gen(function* () {
    let config = { mcp_servers: { preview: { url: "http://host/one", bearer_token: "first" } } };
    let reloads = 0;
    let fail = false;
    const refresh = yield* makeCodexMcpRefresh({
      configuration: Effect.sync(() => config),
      reload: Effect.suspend(() => {
        reloads++;
        return fail
          ? Effect.fail(CodexErrors.CodexAppServerRequestError.invalidParams("Refresh failed"))
          : Effect.succeed({});
      }),
    });
    yield* refresh();
    yield* refresh();
    expect(reloads).toBe(0);
    config = { mcp_servers: { preview: { url: "http://host/two", bearer_token: "second" } } };
    yield* refresh();
    expect(reloads).toBe(1);
    yield* refresh(true);
    expect(reloads).toBe(2);
    config = { mcp_servers: { preview: { url: "http://host/two", bearer_token: "third" } } };
    fail = true;
    yield* refresh().pipe(Effect.flip);
    expect(reloads).toBe(3);
    fail = false;
    yield* refresh();
    yield* refresh();
    expect(reloads).toBe(4);
  }),
);

it.effect("serializes overlapping turns through one native reload", () =>
  Effect.gen(function* () {
    let config: Record<string, unknown> = {};
    let reloads = 0;
    const entered = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    const refresh = yield* makeCodexMcpRefresh({
      configuration: Effect.sync(() => config),
      reload: Effect.gen(function* () {
        reloads++;
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(released);
      }),
    });
    config = { mcp_servers: { local: { enabled: false } } };
    const first = yield* refresh().pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const second = yield* refresh().pipe(Effect.forkChild);
    yield* Deferred.succeed(released, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    expect(reloads).toBe(1);
  }),
);
