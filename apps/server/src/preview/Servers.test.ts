import { it, expect } from "@effect/vitest";
import { ThreadId, type DiscoveredLocalServer, type TerminalEvent } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import type { PortDiscovery } from "./PortScanner.ts";
import type { TerminalManager } from "../terminal/Manager.ts";
import { makeWith } from "./Servers.ts";

const input = { threadId: ThreadId.make("preview-thread"), scriptId: "dev" };
const fixture = Effect.gen(function* () {
  const opened: string[] = [],
    closed: string[] = [],
    commands: string[] = [];
  const closeReceipt = yield* Deferred.make<string>();
  let eventListener: (event: TerminalEvent) => Effect.Effect<void> = () => Effect.void;
  let portListener: (servers: ReadonlyArray<DiscoveredLocalServer>) => Effect.Effect<void> = () =>
    Effect.void;
  let discovered: ReadonlyArray<DiscoveredLocalServer> = [];
  const terminals = {
    open: (value) =>
      Effect.sync(() => {
        opened.push(value.terminalId);
        return {
          threadId: value.threadId,
          terminalId: value.terminalId,
          cwd: value.cwd,
          worktreePath: value.worktreePath ?? null,
          status: "running" as const,
          pid: 123,
          history: "",
          label: "Preview",
          exitCode: null,
          exitSignal: null,
          updatedAt: "2026-09-12T00:00:00Z",
        };
      }),
    close: (value) =>
      Effect.gen(function* () {
        closed.push(value.terminalId!);
        yield* Deferred.succeed(closeReceipt, value.terminalId!);
      }),
    write: (value) =>
      Effect.sync(() => {
        commands.push(value.data);
      }),
    subscribe: (listener) =>
      Effect.sync(() => {
        eventListener = listener;
        return () => {};
      }),
  } satisfies Pick<TerminalManager["Service"], "open" | "close" | "write" | "subscribe">;
  const ports = {
    scan: () => Effect.sync(() => discovered),
    subscribe: (_input, listener) =>
      Effect.sync(() => {
        portListener = listener;
      }),
    retain: Effect.void,
    registerTerminalProcesses: () => Effect.void,
    unregisterTerminal: () => Effect.void,
  } satisfies PortDiscovery["Service"];
  const manager = yield* makeWith({
    terminals,
    ports,
    portAvailable: () => Effect.sync(() => discovered.length === 0),
    readinessTimeoutMs: 1000,
    resolve: () =>
      Effect.succeed({
        name: "Dev",
        command: "vp dev",
        cwd: "/repo/worktree",
        env: {},
        url: "http://localhost:5173",
      }),
  });
  const server = (terminalId: string): DiscoveredLocalServer => ({
    host: "localhost",
    port: 5173,
    url: "http://localhost:5173",
    pid: 123,
    processName: "node",
    terminal: { threadId: input.threadId, terminalId },
  });
  return {
    manager,
    opened,
    closed,
    commands,
    closeReceipt,
    server,
    ports: (values: ReadonlyArray<DiscoveredLocalServer>) => portListener(values),
    emit: (event: TerminalEvent) => eventListener(event),
    setDiscovered: (value: ReadonlyArray<DiscoveredLocalServer>) => {
      discovered = value;
    },
  };
});

it.effect(
  "reuses a named server, requires its owned listener, and restarts only its terminal",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.manager.start(input);
      expect((yield* f.manager.start(input)).terminalId).toBe(first.terminalId);
      expect(f.opened).toHaveLength(1);
      expect(f.commands).toEqual(["vp dev\r"]);
      yield* f.ports([f.server("someone-elses-terminal")]);
      expect((yield* f.manager.list(input.threadId))[0]?.status).toBe("starting");
      yield* f.ports([f.server(first.terminalId)]);
      expect((yield* f.manager.list(input.threadId))[0]?.status).toBe("ready");
      const next = yield* f.manager.restart(input);
      expect(next.terminalId).not.toBe(first.terminalId);
      expect(f.closed).toEqual([first.terminalId]);
      yield* f.manager.stop(input);
      expect(f.closed).toEqual([first.terminalId, next.terminalId]);
      expect((yield* f.manager.list(input.threadId))[0]?.status).toBe("stopped");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not launch or stop the owner of a conflicting port", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.setDiscovered([f.server("foreign")]);
    const failure = yield* f.manager.start(input).pipe(Effect.flip);
    expect(failure.message).toContain("already in use");
    expect(f.opened).toEqual([]);
    expect(f.closed).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("readiness expiry drains its terminal and reports failure", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const started = yield* f.manager.start(input);
    yield* TestClock.adjust(1000);
    expect(yield* Deferred.await(f.closeReceipt)).toBe(started.terminalId);
    expect((yield* f.manager.list(input.threadId))[0]?.status).toBe("failed");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a command exit fails its server without accepting a stale listener", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const started = yield* f.manager.start(input);
    yield* f.emit({
      ...input,
      terminalId: started.terminalId,
      type: "exited",
      exitCode: 1,
      exitSignal: null,
    });
    yield* Deferred.await(f.closeReceipt);
    yield* f.ports([f.server(started.terminalId)]);
    expect((yield* f.manager.list(input.threadId))[0]?.status).toBe("failed");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
