import {
  CommandId,
  EventId,
  MessageId,
  PreviewVerificationError,
  PreviewVerificationRun,
  type OrchestrationEvent,
  type PreviewVerificationReport,
  type PreviewVerificationState,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { resolveProjectAgentBrowserAccess } from "@t3tools/shared/serverSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ServerConfig } from "../config.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { RuntimeReceiptBus } from "../orchestration/Services/RuntimeReceiptBus.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";

export const VERIFICATION_TIMEOUT_MS = 5 * 60_000;
const isVerificationError = Schema.is(PreviewVerificationError);
const isVerificationRun = Schema.is(PreviewVerificationRun);
const ACTIVITY_KIND = "preview.verification";
export class PreviewVerification extends Context.Service<
  PreviewVerification,
  {
    readonly get: (
      threadId: ThreadId,
    ) => Effect.Effect<PreviewVerificationState, PreviewVerificationError>;
    readonly changes: (
      threadId: ThreadId,
    ) => Stream.Stream<PreviewVerificationState, PreviewVerificationError>;
    readonly setEnabled: (
      threadId: ThreadId,
      enabled: boolean,
    ) => Effect.Effect<void, PreviewVerificationError>;
    readonly cancel: (threadId: ThreadId) => Effect.Effect<void, PreviewVerificationError>;
    readonly report: (
      threadId: ThreadId,
      report: PreviewVerificationReport,
    ) => Effect.Effect<void, PreviewVerificationError>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/preview/Verification/PreviewVerification") {}

interface ActiveRun {
  readonly run: PreviewVerificationRun;
  readonly messageId: MessageId;
  readonly scope: Scope.Closeable;
  cancelled: boolean;
  report: PreviewVerificationReport | undefined;
}

/** One opt-in native turn after a completed checkpoint. The provider owns its execution loop. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const receipts = yield* RuntimeReceiptBus;
  const projections = yield* ProjectionSnapshotQuery;
  const settings = yield* ServerSettingsService;
  const browser = yield* PreviewAutomationBroker;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const serviceScope = yield* Effect.scope;
  const mutations = yield* Semaphore.make(1);
  const runs = yield* SubscriptionRef.make<ReadonlyMap<ThreadId, PreviewVerificationRun | null>>(
    new Map(),
  );
  const active = new Map<ThreadId, ActiveRun>();
  const candidates = new Map<
    ThreadId,
    Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>["payload"]
  >();
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const wrap = <A, E>(threadId: ThreadId, effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isVerificationError(cause)
          ? cause
          : new PreviewVerificationError({
              threadId,
              message: "Preview verification could not complete.",
              cause,
            }),
      ),
    );
  let enqueueTimeout: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;
  const commandId = (runId: string, action: string) =>
    CommandId.make(`preview-verification:${runId}:${action}`);

  const publish = Effect.fn("PreviewVerification.publish")(function* (
    threadId: ThreadId,
    run: PreviewVerificationRun,
  ) {
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: commandId(run.runId, run.status),
      threadId,
      activity: {
        id: EventId.make(`preview-verification:${run.runId}:${run.status}`),
        tone: run.status === "failed" ? "error" : "info",
        kind: ACTIVITY_KIND,
        summary: `Preview verification ${run.status}: ${run.summary}`.slice(0, 500),
        payload: run,
        turnId: null,
        createdAt: run.updatedAt,
      },
      createdAt: run.updatedAt,
    });
    yield* SubscriptionRef.update(runs, (current) => new Map(current).set(threadId, run));
  });

  const get = Effect.fn("PreviewVerification.get")(function* (threadId: ThreadId) {
    if (!(yield* SubscriptionRef.get(runs)).has(threadId)) {
      const latest = yield* projections.getLatestThreadActivity({ threadId, kind: ACTIVITY_KIND });
      const stored =
        Option.isSome(latest) && isVerificationRun(latest.value.payload)
          ? latest.value.payload
          : null;
      const recovered =
        stored?.status === "running"
          ? {
              ...stored,
              status: "cancelled" as const,
              summary: "The environment restarted before verification finished.",
              updatedAt: yield* now,
            }
          : stored;
      yield* SubscriptionRef.update(runs, (current) =>
        current.has(threadId) ? current : new Map(current).set(threadId, recovered),
      );
    }
    return {
      enabled: (yield* settings.getSettings).previewVerificationThreads[threadId] === true,
      run: (yield* SubscriptionRef.get(runs)).get(threadId) ?? null,
    };
  });

  const finish = Effect.fn("PreviewVerification.finish")(function* (
    threadId: ThreadId,
    entry: ActiveRun,
    status: "passed" | "failed" | "cancelled",
    summary: string,
  ) {
    if (active.get(threadId) !== entry) return;
    active.delete(threadId);
    yield* Scope.close(entry.scope, Exit.void);
    if ((yield* SubscriptionRef.get(runs)).get(threadId)?.status === status) return;
    yield* publish(threadId, {
      ...entry.run,
      status,
      summary,
      url: entry.report?.url ?? null,
      evidencePaths: entry.report?.evidencePaths ?? [],
      updatedAt: yield* now,
    });
  });

  const cancel = Effect.fn("PreviewVerification.cancel")(function* (
    threadId: ThreadId,
    reason: string,
  ) {
    const entry = active.get(threadId);
    if (!entry) return;
    const alreadyCancelled = entry.cancelled;
    entry.cancelled = true;
    const thread = yield* projections.getThreadShellById(threadId);
    if (
      Option.isSome(thread) &&
      thread.value.latestUserMessageAt === entry.run.startedAt &&
      thread.value.session?.activeTurnId != null
    ) {
      yield* engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: commandId(entry.run.runId, "interrupt"),
        threadId,
        turnId: thread.value.session.activeTurnId,
        expectedUserMessageAt: entry.run.startedAt,
        createdAt: yield* now,
      });
      yield* finish(threadId, entry, "cancelled", reason);
    } else if (
      Option.isNone(thread) ||
      thread.value.latestUserMessageAt !== entry.run.startedAt ||
      thread.value.session?.status === "stopped" ||
      thread.value.session?.status === "error" ||
      (thread.value.latestTurn?.requestedAt === entry.run.startedAt &&
        thread.value.latestTurn.state !== "running")
    ) {
      yield* finish(threadId, entry, "cancelled", reason);
    } else if (!alreadyCancelled) {
      // Keep only the pending-start tombstone so a late native turn is interrupted.
      // The visible run ends immediately; new user work also clears this tombstone.
      yield* publish(threadId, {
        ...entry.run,
        status: "cancelled",
        summary: reason,
        updatedAt: yield* now,
      });
    }
  });

  const consider = Effect.fn("PreviewVerification.consider")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }>,
  ) {
    const { threadId, turnId } = event.payload;
    const candidate = candidates.get(threadId);
    if (
      !candidate ||
      candidate.messageOrigin?.kind !== "human" ||
      candidate.interactionMode !== "default" ||
      event.payload.status !== "ready" ||
      event.payload.files.length === 0 ||
      active.has(threadId)
    )
      return;
    const preferences = yield* settings.getSettings;
    if (preferences.previewVerificationThreads[threadId] !== true) return;
    const thread = yield* projections.getThreadShellById(threadId);
    if (
      Option.isNone(thread) ||
      thread.value.latestTurn?.turnId !== turnId ||
      thread.value.latestTurn.state !== "completed" ||
      thread.value.latestUserMessageAt !== candidate.createdAt ||
      thread.value.latestTurn.requestedAt !== candidate.createdAt ||
      thread.value.backgroundLiveness != null
    )
      return;
    candidates.delete(threadId);
    const runId = yield* crypto.randomUUIDv4;
    const startedAt = yield* now;
    const run: PreviewVerificationRun = {
      runId,
      checkpointTurnId: turnId,
      status: "running",
      summary: "Checking the completed change in Preview.",
      url: null,
      evidencePaths: [],
      startedAt,
      updatedAt: startedAt,
    };
    if (
      !resolveProjectAgentBrowserAccess(preferences, thread.value.projectId) ||
      !(yield* browser.hasHost)
    ) {
      yield* publish(threadId, {
        ...run,
        status: "failed",
        summary:
          "Verification needs browser access and a connected desktop host. No verification turn was started.",
      });
      return;
    }
    const scope = yield* Scope.fork(serviceScope, "sequential");
    const entry: ActiveRun = {
      run,
      messageId: MessageId.make(`preview-verification:${runId}`),
      scope,
      cancelled: false,
      report: undefined,
    };
    active.set(threadId, entry);
    yield* publish(threadId, run);
    yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId: commandId(runId, "start"),
        threadId,
        expectedCompletedTurnId: turnId,
        messageOrigin: { kind: "automation" },
        message: {
          messageId: entry.messageId,
          role: "user",
          attachments: [],
          text: `Preview verification is enabled for this thread. Perform one bounded verification pass of the just-completed change using the existing Preview host and the selected native browser engine. You have at most five minutes. Inspect and exercise the relevant behavior; do not edit files or start another agent. Reuse or start an existing named preview server if needed. Save screenshot or other file evidence in the environment. Report unresolved failures honestly, including unavailable browser/server access. Finish by calling preview_verification_report with runId ${runId}, status passed or failed, summary, the tested URL, and absolute evidencePaths. A passed result requires evidence. Then end this turn. Do not schedule another verification pass.`,
        },
        modelSelection: thread.value.modelSelection,
        runtimeMode: thread.value.runtimeMode,
        interactionMode: "default",
        createdAt: startedAt,
      })
      .pipe(
        Effect.catchCause((cause) =>
          finish(
            threadId,
            entry,
            "cancelled",
            `Newer work or a startup failure prevented verification: ${Cause.pretty(cause).slice(0, 500)}`,
          ),
        ),
      );
    if (active.get(threadId) === entry)
      yield* Effect.sleep(VERIFICATION_TIMEOUT_MS).pipe(
        Effect.andThen(enqueueTimeout(threadId)),
        Effect.forkIn(scope),
      );
  });

  const process = Effect.fn("PreviewVerification.process")(function* (
    input:
      | OrchestrationEvent
      | { readonly type: "timeout"; readonly threadId: ThreadId }
      | { readonly type: "settings" },
  ) {
    if (input.type === "settings") {
      const preferences = yield* settings.getSettings;
      for (const threadId of active.keys()) {
        const thread = yield* projections.getThreadShellById(threadId);
        if (
          preferences.previewVerificationThreads[threadId] !== true ||
          Option.isNone(thread) ||
          !resolveProjectAgentBrowserAccess(preferences, thread.value.projectId)
        )
          yield* cancel(threadId, "Verification was disabled.");
      }
      return;
    }
    if (input.type === "timeout")
      return yield* cancel(input.threadId, "Verification reached its five-minute limit.");
    if (input.type === "thread.turn-start-requested") {
      const entry = active.get(input.payload.threadId);
      if (entry?.messageId === input.payload.messageId) return;
      if (entry)
        yield* finish(
          input.payload.threadId,
          entry,
          "cancelled",
          "New user or peer work superseded verification.",
        );
      candidates.set(input.payload.threadId, {
        ...input.payload,
        messageOrigin: input.payload.messageOrigin ?? { kind: "human" },
      });
      return;
    }
    if (input.type === "thread.session-set" || input.type === "thread.turn-diff-completed") {
      const threadId = input.payload.threadId;
      const entry = active.get(threadId);
      if (entry) {
        const thread = yield* projections.getThreadShellById(threadId);
        if (entry.cancelled) return yield* cancel(threadId, "Verification was cancelled.");
        if (
          Option.isSome(thread) &&
          thread.value.latestTurn?.requestedAt === entry.run.startedAt &&
          thread.value.latestTurn.state !== "running"
        ) {
          const successful = thread.value.latestTurn.state === "completed";
          yield* finish(
            threadId,
            entry,
            successful ? (entry.report?.status ?? "failed") : "cancelled",
            entry.report?.summary ??
              (successful
                ? "The agent ended without reporting verification evidence."
                : "The verification turn was interrupted."),
          );
        }
      } else if (input.type === "thread.turn-diff-completed") yield* consider(input);
    }
    if (input.type === "thread.deleted") {
      const threadId = input.payload.threadId;
      const entry = active.get(threadId);
      active.delete(threadId);
      candidates.delete(threadId);
      if (entry) yield* Scope.close(entry.scope, Exit.void);
      yield* SubscriptionRef.update(runs, (current) => {
        const next = new Map(current);
        next.delete(threadId);
        return next;
      });
    }
  });
  const worker = yield* makeDrainableWorker((input: Parameters<typeof process>[0]) =>
    mutations.withPermit(process(input)).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("Preview verification failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.ensuring(
        receipts.publish({
          type: "preview.verification.processed",
          inputType: input.type,
          ...("eventId" in input ? { eventId: input.eventId } : {}),
        }),
      ),
    ),
  );
  enqueueTimeout = (threadId) => worker.enqueue({ type: "timeout", threadId });
  const events = yield* engine.subscribeDomainEvents;
  const settingsChanges = yield* settings.subscribeChanges;
  yield* forkParked(
    Stream.runForEach(events, (event) =>
      [
        "thread.turn-start-requested",
        "thread.turn-diff-completed",
        "thread.session-set",
        "thread.deleted",
      ].includes(event.type)
        ? worker.enqueue(event)
        : Effect.void,
    ),
  );
  yield* forkParked(Stream.runForEach(settingsChanges, () => worker.enqueue({ type: "settings" })));

  const report = Effect.fn("PreviewVerification.report")(function* (
    threadId: ThreadId,
    report: PreviewVerificationReport,
  ) {
    const entry = active.get(threadId);
    const thread = yield* projections.getThreadShellById(threadId);
    if (
      !entry ||
      entry.run.runId !== report.runId ||
      entry.cancelled ||
      Option.isNone(thread) ||
      thread.value.latestUserMessageAt !== entry.run.startedAt ||
      thread.value.latestTurn?.requestedAt !== entry.run.startedAt ||
      thread.value.latestTurn.state !== "running"
    )
      return yield* new PreviewVerificationError({
        threadId,
        message: "This verification run is no longer active.",
      });
    const page = report.url === null ? null : URL.parse(report.url);
    if (
      report.status === "passed" &&
      (!page || !["http:", "https:"].includes(page.protocol) || report.evidencePaths.length === 0)
    )
      return yield* new PreviewVerificationError({
        threadId,
        message: "A passed verification needs the tested page and saved evidence.",
      });
    const evidencePaths: string[] = [];
    yield* fs.makeDirectory(config.browserArtifactsDir, { recursive: true });
    for (const [index, source] of report.evidencePaths.entries()) {
      const info = yield* fs.stat(source);
      const extension = path.extname(source).toLowerCase();
      if (
        !path.isAbsolute(source) ||
        info.type !== "File" ||
        info.size <= 0 ||
        info.size > 20 * 1024 * 1024 ||
        ![".png", ".jpg", ".jpeg", ".webp", ".json", ".txt", ".webm", ".mp4"].includes(extension)
      )
        return yield* new PreviewVerificationError({
          threadId,
          message: "Evidence must be an existing image, video, JSON or text file of at most 20 MB.",
        });
      const destination = path.join(
        config.browserArtifactsDir,
        `verification-${report.runId}-${index}${extension}`,
      );
      yield* fs.copyFile(source, destination);
      evidencePaths.push(destination);
    }
    entry.report = { ...report, evidencePaths };
  });
  return PreviewVerification.of({
    get: (threadId) => wrap(threadId, get(threadId)),
    changes: (threadId) =>
      Stream.merge(
        SubscriptionRef.changes(runs).pipe(
          Stream.map((current) => current.get(threadId)),
          Stream.changes,
          Stream.map(() => undefined),
        ),
        settings.streamChanges.pipe(Stream.map(() => undefined)),
        {},
      ).pipe(
        Stream.mapEffect(() => wrap(threadId, get(threadId))),
        Stream.changesWith((left, right) => Equal.equals(left, right)),
      ),
    setEnabled: (threadId, enabled) =>
      wrap(
        threadId,
        settings
          .updateSettings({ previewVerificationThreads: { [threadId]: enabled || null } })
          .pipe(
            Effect.andThen(
              enabled
                ? Effect.void
                : mutations.withPermit(cancel(threadId, "Verification was disabled.")),
            ),
          ),
      ),
    cancel: (threadId) =>
      wrap(threadId, mutations.withPermit(cancel(threadId, "Verification was stopped."))),
    report: (threadId, input) => wrap(threadId, mutations.withPermit(report(threadId, input))),
    drain: worker.drain,
  });
});
export const layer = Layer.effect(PreviewVerification, make);
