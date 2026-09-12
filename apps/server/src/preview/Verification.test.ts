import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type MessageOrigin,
  type OrchestrationCommand,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  RuntimeReceiptBus,
  type OrchestrationRuntimeReceipt,
} from "../orchestration/Services/RuntimeReceiptBus.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { make, VERIFICATION_TIMEOUT_MS } from "./Verification.ts";

const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);

const threadId = ThreadId.make("verification-thread");
const sourceTurn = TurnId.make("changed-turn");
const verificationTurn = TurnId.make("verification-turn");
const humanAt = "2026-09-12T10:00:00.000Z";

const fixture = Effect.gen(function* () {
  let preferences = { ...DEFAULT_SERVER_SETTINGS };
  let hasHost = true;
  let latestActivity: OrchestrationThreadActivity | undefined;
  let thread: OrchestrationThreadShell = {
    id: threadId,
    projectId: ProjectId.make("project"),
    pullRequests: [],
  title: "Verify fixture",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claude"),
      model: "selected-model",
      options: [{ id: "effort", value: "ultracode" }],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: sourceTurn,
      state: "completed",
      requestedAt: humanAt,
      startedAt: humanAt,
      completedAt: humanAt,
      assistantMessageId: null,
    },
    createdAt: humanAt,
    updatedAt: humanAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: {
      threadId,
      runtimeMode: "full-access",
      status: "ready",
      providerName: "claude",
      activeTurnId: null,
      lastError: null,
      updatedAt: humanAt,
    },
    latestUserMessageAt: humanAt,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
  const commands: OrchestrationCommand[] = [];
  const domain = yield* PubSub.unbounded<OrchestrationEvent>();
  const changes = yield* PubSub.unbounded<typeof preferences>();
  const receipts = yield* Queue.unbounded<OrchestrationRuntimeReceipt>();
  const service = yield* make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          subscribeDomainEvents: PubSub.subscribe(domain).pipe(Effect.map(Stream.fromSubscription)),
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              if (command.type === "thread.activity.append") latestActivity = command.activity;
              if (command.type === "thread.turn.start")
                thread = { ...thread, latestUserMessageAt: command.createdAt };
              return { sequence: commands.length };
            }),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: () => Effect.sync(() => Option.some(thread)),
          getLatestThreadActivity: () => Effect.sync(() => Option.fromUndefinedOr(latestActivity)),
        }),
        Layer.mock(ServerSettingsService)({
          getSettings: Effect.sync(() => preferences),
          updateSettings: (patch) =>
            Effect.gen(function* () {
              preferences = applyServerSettingsPatch(preferences, patch);
              yield* PubSub.publish(changes, preferences);
              return preferences;
            }),
          streamChanges: Stream.fromPubSub(changes),
          subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
        }),
        Layer.mock(PreviewAutomationBroker)({ hasHost: Effect.sync(() => hasHost) }),
        Layer.mock(RuntimeReceiptBus)({
          publish: (receipt) => Queue.offer(receipts, receipt).pipe(Effect.asVoid),
        }),
      ),
    ),
  );
  let sequence = 0;
  const event = (type: OrchestrationEvent["type"], payload: unknown) =>
    decodeEvent({
      type,
      payload,
      sequence: ++sequence,
      eventId: `event-${sequence}`,
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: humanAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
    });
  const awaitReceipt = (
    matches: (receipt: OrchestrationRuntimeReceipt) => boolean,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      while (!matches(yield* Queue.take(receipts))) {}
    });
  const emit = (value: OrchestrationEvent) =>
    PubSub.publish(domain, value).pipe(
      Effect.andThen(
        awaitReceipt(
          (receipt) =>
            receipt.type === "preview.verification.processed" && receipt.eventId === value.eventId,
        ),
      ),
      Effect.andThen(service.drain),
    );
  const startEvent = (origin: MessageOrigin = { kind: "human" }) =>
    emit(
      event("thread.turn-start-requested", {
        threadId,
        messageId: "human-message",
        messageOrigin: origin,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: humanAt,
      }),
    );
  const checkpoint = (
    files = [{ path: "app.tsx", kind: "modified", additions: 1, deletions: 0 }],
  ) =>
    emit(
      event("thread.turn-diff-completed", {
        threadId,
        turnId: sourceTurn,
        checkpointTurnCount: 1,
        checkpointRef: "refs/t3/checkpoint",
        status: "ready",
        files,
        assistantMessageId: null,
        completedAt: humanAt,
      }),
    );
  const startCommands = () => commands.filter((command) => command.type === "thread.turn.start");
  const beginVerification = () =>
    Effect.gen(function* () {
      const command = startCommands()[0]!;
      thread = {
        ...thread,
        latestUserMessageAt: command.createdAt,
        latestTurn: {
          turnId: verificationTurn,
          state: "running",
          requestedAt: command.createdAt,
          startedAt: command.createdAt,
          completedAt: null,
          assistantMessageId: null,
        },
        session: { ...thread.session!, status: "running", activeTurnId: verificationTurn },
      };
      yield* emit(
        event("thread.turn-start-requested", {
          threadId,
          messageId: command.message.messageId,
          messageOrigin: command.messageOrigin,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          createdAt: command.createdAt,
        }),
      );
      yield* emit(
        event("thread.session-set", {
          threadId,
          session: thread.session,
          createdAt: command.createdAt,
        }),
      );
    });
  const complete = () =>
    Effect.gen(function* () {
      thread = {
        ...thread,
        latestTurn: { ...thread.latestTurn!, state: "completed" },
        session: { ...thread.session!, status: "ready", activeTurnId: null },
      };
      yield* emit(
        event("thread.session-set", { threadId, session: thread.session, createdAt: humanAt }),
      );
    });
  return {
    service,
    commands,
    startCommands,
    startEvent,
    checkpoint,
    beginVerification,
    complete,
    failStartup: () =>
      Effect.gen(function* () {
        thread = {
          ...thread,
          session: {
            ...thread.session!,
            status: "error",
            activeTurnId: null,
            lastError: "fixture startup failed",
          },
        };
        yield* emit(
          event("thread.session-set", { threadId, session: thread.session, createdAt: humanAt }),
        );
      }),
    emit,
    event,
    awaitTimeout: awaitReceipt(
      (receipt) =>
        receipt.type === "preview.verification.processed" && receipt.inputType === "timeout",
    ),
    setHost: (value: boolean) => {
      hasHost = value;
    },
    humanSteers: () =>
      Effect.gen(function* () {
        const createdAt = "2026-09-12T11:00:00.000Z";
        thread = { ...thread, latestUserMessageAt: createdAt };
        yield* emit(
          event("thread.turn-start-requested", {
            threadId,
            messageId: "newer-human",
            messageOrigin: { kind: "human" },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt,
          }),
        );
      }),
  };
});
const TestLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-verification-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.effect("is opt-in and starts one native follow-up only after a human change", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.startEvent();
    yield* f.checkpoint();
    expect(f.startCommands()).toHaveLength(0);
    yield* f.service.setEnabled(threadId, true);
    yield* f.startEvent({ kind: "automation" });
    yield* f.checkpoint();
    yield* f.startEvent({ kind: "peer", from: "other-agent" });
    yield* f.checkpoint();
    expect(f.startCommands()).toHaveLength(0);
    yield* f.startEvent();
    yield* f.checkpoint([]);
    expect(f.startCommands()).toHaveLength(0);
    yield* f.checkpoint();
    yield* f.checkpoint();
    expect(f.startCommands()).toHaveLength(1);
    expect(f.startCommands()[0]).toMatchObject({
      expectedCompletedTurnId: sourceTurn,
      messageOrigin: { kind: "automation" },
      modelSelection: {
        instanceId: "claude",
        model: "selected-model",
        options: [{ id: "effort", value: "ultracode" }],
      },
    });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("requires real evidence and a completed turn before reporting passed", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.service.setEnabled(threadId, true);
    yield* f.startEvent();
    yield* f.checkpoint();
    yield* f.beginVerification();
    const run = (yield* f.service.get(threadId)).run!;
    const report = {
      runId: run.runId,
      status: "passed" as const,
      summary: "The changed form submits and renders its result.",
      url: "http://localhost:5173/form",
      evidencePaths: [] as string[],
    };
    expect((yield* Effect.exit(f.service.report(threadId, report)))._tag).toBe("Failure");
    const fs = yield* FileSystem.FileSystem;
    const folder = yield* fs.makeTempDirectoryScoped();
    const source = `${folder}/observations.txt`;
    yield* fs.writeFileString(source, "Submitted the form and observed the result.");
    yield* f.service.report(threadId, { ...report, evidencePaths: [source] });
    expect((yield* f.service.get(threadId)).run?.status).toBe("running");
    yield* f.complete();
    const completed = (yield* f.service.get(threadId)).run!;
    expect(completed.status).toBe("passed");
    expect(yield* fs.readFileString(completed.evidencePaths[0]!)).toContain("observed the result");
    expect(completed.evidencePaths[0]).not.toBe(source);
    yield* f.checkpoint();
    expect(f.startCommands()).toHaveLength(1);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("stops on disable and rejects reports from a cancelled run", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.service.setEnabled(threadId, true);
    yield* f.startEvent();
    yield* f.checkpoint();
    yield* f.beginVerification();
    const run = (yield* f.service.get(threadId)).run!;
    yield* f.service.setEnabled(threadId, false);
    expect(yield* f.service.get(threadId)).toMatchObject({
      enabled: false,
      run: { status: "cancelled" },
    });
    expect(f.commands.find((command) => command.type === "thread.turn.interrupt")).toMatchObject({
      turnId: verificationTurn,
      expectedUserMessageAt: run.startedAt,
    });
    expect(
      (yield* Effect.exit(
        f.service.report(threadId, {
          runId: run.runId,
          status: "failed",
          summary: "late",
          url: null,
          evidencePaths: [],
        }),
      ))._tag,
    ).toBe("Failure");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("shows cancellation during startup and drains failed or late native starts", () =>
  Effect.gen(function* () {
    for (const lateStart of [false, true]) {
      const f = yield* fixture;
      yield* f.service.setEnabled(threadId, true);
      yield* f.startEvent();
      yield* f.checkpoint();
      yield* f.service.cancel(threadId);
      expect((yield* f.service.get(threadId)).run?.status).toBe("cancelled");
      if (lateStart) yield* f.beginVerification();
      else yield* f.failStartup();
      expect((yield* f.service.get(threadId)).run?.status).toBe("cancelled");
      expect(f.commands.filter((command) => command.type === "thread.turn.interrupt")).toHaveLength(
        lateStart ? 1 : 0,
      );
    }
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("ends at its deadline and leaves newer human work alone", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.service.setEnabled(threadId, true);
    yield* f.startEvent();
    yield* f.checkpoint();
    yield* f.beginVerification();
    yield* TestClock.adjust(VERIFICATION_TIMEOUT_MS);
    yield* f.awaitTimeout;
    expect((yield* f.service.get(threadId)).run?.status).toBe("cancelled");
    const newer = yield* fixture;
    yield* newer.service.setEnabled(threadId, true);
    yield* newer.startEvent();
    yield* newer.checkpoint();
    yield* newer.beginVerification();
    yield* newer.humanSteers();
    yield* newer.service.cancel(threadId);
    yield* TestClock.adjust(VERIFICATION_TIMEOUT_MS);
    expect(
      newer.commands.filter((command) => command.type === "thread.turn.interrupt"),
    ).toHaveLength(0);
    expect((yield* newer.service.get(threadId)).run?.status).toBe("cancelled");
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("reports a missing host without starting another provider request", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.setHost(false);
    yield* f.service.setEnabled(threadId, true);
    yield* f.startEvent();
    yield* f.checkpoint();
    expect(f.startCommands()).toHaveLength(0);
    expect((yield* f.service.get(threadId)).run).toMatchObject({
      status: "failed",
      evidencePaths: [],
    });
  }).pipe(Effect.provide(TestLayer)),
);
