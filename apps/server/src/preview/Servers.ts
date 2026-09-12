import {
  PreviewServerError,
  type PreviewServerInput,
  type PreviewServerStatus,
  type ThreadId,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv, resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { NetService } from "@t3tools/shared/Net";
import { isLoopbackHost } from "@t3tools/shared/preview";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { PortDiscovery } from "./PortScanner.ts";

const isPreviewServerError = Schema.is(PreviewServerError);

export class PreviewServers extends Context.Service<
  PreviewServers,
  {
    readonly start: (
      input: PreviewServerInput,
    ) => Effect.Effect<PreviewServerStatus, PreviewServerError>;
    readonly stop: (input: PreviewServerInput) => Effect.Effect<void, PreviewServerError>;
    readonly restart: (
      input: PreviewServerInput,
    ) => Effect.Effect<PreviewServerStatus, PreviewServerError>;
    readonly list: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<PreviewServerStatus>>;
    readonly changes: (threadId: ThreadId) => Stream.Stream<ReadonlyArray<PreviewServerStatus>>;
  }
>()("t3/preview/Servers/PreviewServers") {}

interface Launch {
  readonly name: string;
  readonly command: string;
  readonly cwd: string;
  readonly worktreePath?: string;
  readonly env: Record<string, string>;
  readonly url?: string;
}
interface OwnedServer {
  readonly input: PreviewServerInput;
  readonly terminalId: string;
  readonly scope: Scope.Closeable;
  readonly url: string | undefined;
  observedSubprocess: boolean;
  observedReady: boolean;
}
const keyFor = (input: PreviewServerInput) => JSON.stringify([input.threadId, input.scriptId]);
const samePort = (left: string, right: string) => {
  const a = new URL(left),
    b = new URL(right);
  return (
    (a.port || (a.protocol === "https:" ? "443" : "80")) ===
    (b.port || (b.protocol === "https:" ? "443" : "80"))
  );
};

/** Coordinates existing terminals and their port ownership; never spawns or scans processes itself. */
export const makeWith = Effect.fn("PreviewServers.make")(function* (dependencies: {
  readonly terminals: Pick<TerminalManager["Service"], "open" | "write" | "close" | "subscribe">;
  readonly ports: PortDiscovery["Service"];
  readonly resolve: (input: PreviewServerInput) => Effect.Effect<Launch, PreviewServerError>;
  readonly portAvailable: (port: number) => Effect.Effect<boolean>;
  readonly readinessTimeoutMs?: number;
}) {
  const serviceScope = yield* Effect.scope;
  const crypto = yield* Crypto.Crypto;
  const entries = new Map<string, OwnedServer>();
  const statuses = yield* SubscriptionRef.make<ReadonlyMap<string, PreviewServerStatus>>(new Map());
  const mutations = yield* Semaphore.make(1);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const isActive = (entry: OwnedServer) => entries.get(keyFor(entry.input)) === entry;
  const publish = (
    entry: OwnedServer,
    change: Partial<Pick<PreviewServerStatus, "status" | "url" | "message">>,
  ) =>
    Effect.gen(function* () {
      const updatedAt = yield* now;
      yield* SubscriptionRef.update(statuses, (current) => {
        const key = keyFor(entry.input),
          previous = current.get(key);
        if (
          !isActive(entry) ||
          !previous ||
          (previous.status === change.status &&
            previous.url === change.url &&
            previous.message === change.message)
        )
          return current;
        return new Map(current).set(key, { ...previous, ...change, updatedAt });
      });
    });
  const fail = (entry: OwnedServer, message: string) =>
    Effect.gen(function* () {
      if (!isActive(entry)) return;
      yield* publish(entry, { status: "failed", message, url: null });
      entries.delete(keyFor(entry.input));
      // Terminal callbacks may hold the terminal's lock. Release outside that callback.
      yield* Scope.close(entry.scope, Exit.void).pipe(Effect.forkIn(serviceScope));
    });
  yield* Effect.acquireRelease(
    dependencies.terminals.subscribe((event) =>
      Effect.gen(function* () {
        const entry = [...entries.values()].find(
          (candidate) =>
            candidate.input.threadId === event.threadId &&
            candidate.terminalId === event.terminalId,
        );
        if (!entry) return;
        if (event.type === "activity") {
          if (event.hasRunningSubprocess) entry.observedSubprocess = true;
          else if (entry.observedSubprocess)
            yield* fail(
              entry,
              "The preview command finished. Open its terminal to inspect the output.",
            );
        } else if (event.type === "exited" || event.type === "closed" || event.type === "error") {
          yield* fail(
            entry,
            event.type === "error"
              ? event.message
              : "The preview terminal exited. Open its terminal to inspect the output.",
          );
        }
      }),
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  );

  const stop = Effect.fn("PreviewServers.stop")(function* (input: PreviewServerInput) {
    const entry = entries.get(keyFor(input));
    if (!entry) return;
    yield* publish(entry, { status: "stopped", url: null, message: null });
    entries.delete(keyFor(input));
    yield* Scope.close(entry.scope, Exit.void);
  });
  const start = Effect.fn("PreviewServers.start")(function* (input: PreviewServerInput) {
    const key = keyFor(input);
    const previous = (yield* SubscriptionRef.get(statuses)).get(key);
    if (entries.has(key) && previous) return previous;
    const launch = yield* dependencies.resolve(input);
    if (launch.url) {
      const url = yield* Effect.try({
        try: () => new URL(launch.url!),
        catch: (cause) =>
          new PreviewServerError({
            ...input,
            message: "The script's preview URL must be an HTTP(S) loopback URL.",
            cause,
          }),
      });
      if (!isLoopbackHost(url.hostname) || !["http:", "https:"].includes(url.protocol))
        return yield* new PreviewServerError({
          ...input,
          message:
            "Managed preview URLs must point to a loopback HTTP(S) server in this environment.",
        });
      const occupied = !(yield* dependencies.portAvailable(
        Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      ));
      if (occupied)
        return yield* new PreviewServerError({
          ...input,
          message: `The preview port is already in use (${url.port || url.protocol}). Stop its owner or choose another port in the project script.`,
        });
    }
    const scope = yield* Scope.fork(serviceScope, "sequential");
    const terminalId = `preview-${yield* crypto.randomUUIDv4.pipe(Effect.mapError((cause) => new PreviewServerError({ ...input, message: "Could not allocate a preview terminal.", cause })))}`;
    const entry: OwnedServer = {
      input,
      terminalId,
      scope,
      url: launch.url,
      observedSubprocess: false,
      observedReady: false,
    };
    const initial: PreviewServerStatus = {
      ...input,
      name: launch.name,
      terminalId,
      status: "starting",
      url: null,
      message: null,
      updatedAt: yield* now,
    };
    entries.set(key, entry);
    yield* SubscriptionRef.update(statuses, (current) => new Map(current).set(key, initial));
    const ready = yield* Deferred.make<void>();
    yield* Scope.addFinalizer(
      scope,
      dependencies.terminals
        .close({ threadId: input.threadId, terminalId })
        .pipe(Effect.ignoreCause({ log: true })),
    );
    const begin = Effect.gen(function* () {
      yield* dependencies.ports.retain;
      yield* dependencies.ports.subscribe(
        { configuredUrls: launch.url ? [launch.url] : [], initialSnapshot: [] },
        (servers) =>
          Effect.gen(function* () {
            if (!isActive(entry)) return;
            const server = servers.find(
              (server) =>
                server.terminal?.threadId === input.threadId &&
                server.terminal.terminalId === terminalId &&
                (!entry.url || samePort(server.url, entry.url)),
            );
            if (!server) {
              if (entry.observedReady)
                yield* publish(entry, {
                  status: "starting",
                  url: null,
                  message: "Waiting for the owned preview port to respond.",
                });
              return;
            }
            entry.observedReady = true;
            yield* publish(entry, { status: "ready", url: entry.url ?? server.url, message: null });
            yield* Deferred.succeed(ready, undefined);
          }),
      );
      yield* dependencies.terminals.open({
        threadId: input.threadId,
        terminalId,
        cwd: launch.cwd,
        ...(launch.worktreePath ? { worktreePath: launch.worktreePath } : {}),
        env: launch.env,
      });
      yield* dependencies.terminals.write({
        threadId: input.threadId,
        terminalId,
        data: `${launch.command}\r`,
      });
      yield* Deferred.await(ready).pipe(
        Effect.timeout(dependencies.readinessTimeoutMs ?? 60_000),
        Effect.catch(() =>
          fail(
            entry,
            "The preview did not become ready on its owned port within 60 seconds. Check its terminal and preview URL.",
          ),
        ),
        Effect.forkIn(scope),
      );
    }).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.mapError(
        (cause) =>
          new PreviewServerError({
            ...input,
            message:
              "Could not start the preview script. Check its terminal and project configuration.",
            cause,
          }),
      ),
    );
    yield* begin.pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? fail(entry, "Preview startup failed or was cancelled.")
          : Effect.void,
      ),
    );
    return (yield* SubscriptionRef.get(statuses)).get(key) ?? initial;
  });
  const select = (threadId: ThreadId) => (all: ReadonlyMap<string, PreviewServerStatus>) =>
    [...all.values()].filter((entry) => entry.threadId === threadId);
  return PreviewServers.of({
    start: (input) => mutations.withPermit(start(input)),
    stop: (input) => mutations.withPermit(stop(input)),
    restart: (input) => mutations.withPermit(stop(input).pipe(Effect.andThen(start(input)))),
    list: (threadId) => SubscriptionRef.get(statuses).pipe(Effect.map(select(threadId))),
    changes: (threadId) =>
      SubscriptionRef.changes(statuses).pipe(
        Stream.map(select(threadId)),
        Stream.changesWith(
          (a, b) => a.length === b.length && a.every((value, index) => value === b[index]),
        ),
      ),
  });
});

export const make = Effect.gen(function* () {
  const terminals = yield* TerminalManager;
  const net = yield* NetService;
  const ports = yield* PortDiscovery;
  const projections = yield* ProjectionSnapshotQuery;
  const settings = yield* ServerSettingsService;
  return yield* makeWith({
    terminals,
    ports,
    portAvailable: net.isPortAvailableOnLoopback,
    resolve: (input) =>
      Effect.gen(function* () {
        const thread = yield* projections.getThreadShellById(input.threadId);
        if (Option.isNone(thread))
          return yield* new PreviewServerError({
            ...input,
            message: "This thread no longer exists.",
          });
        const project = yield* projections.getProjectShellById(thread.value.projectId);
        if (Option.isNone(project))
          return yield* new PreviewServerError({
            ...input,
            message: "This project no longer exists.",
          });
        const script = resolveProjectScripts(yield* settings.getSettings, project.value).find(
          (script) => script.id === input.scriptId,
        );
        if (!script)
          return yield* new PreviewServerError({
            ...input,
            message: "This project script no longer exists. Choose an existing script.",
          });
        return {
          name: script.name,
          command: script.command,
          cwd: thread.value.worktreePath ?? project.value.workspaceRoot,
          ...(thread.value.worktreePath ? { worktreePath: thread.value.worktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: project.value.workspaceRoot },
            worktreePath: thread.value.worktreePath,
          }),
          ...(script.previewUrl ? { url: script.previewUrl } : {}),
        };
      }).pipe(
        Effect.mapError((cause) =>
          isPreviewServerError(cause)
            ? cause
            : new PreviewServerError({
                ...input,
                message: "Could not resolve this project's preview script.",
                cause,
              }),
        ),
      ),
  });
});
export const layer = Layer.effect(PreviewServers, make);
