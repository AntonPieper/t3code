import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { decideOrchestrationCommand } from "./decider.ts";

const at = "2026-09-12T10:00:00.000Z";
const threadId = ThreadId.make("verification");
const turnId = TurnId.make("completed");
const thread: OrchestrationThread = {
  id: threadId,
  projectId: ProjectId.make("project"),
  title: "Verification",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "selected" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: {
    turnId,
    state: "completed",
    requestedAt: at,
    startedAt: at,
    completedAt: at,
    assistantMessageId: null,
  },
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  pullRequests: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: {
    threadId,
    status: "ready",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: at,
  },
};
const command = {
  type: "thread.turn.start",
  commandId: CommandId.make("verify"),
  threadId,
  expectedCompletedTurnId: turnId,
  messageOrigin: { kind: "automation" },
  message: {
    messageId: MessageId.make("verification-message"),
    role: "user",
    text: "Verify the change.",
    attachments: [],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-09-12T10:01:00.000Z",
} as const;
const decide = (changed: Partial<OrchestrationThread> = {}) =>
  decideOrchestrationCommand({
    command,
    readModel: {
      projects: [],
      threads: [{ ...thread, ...changed }],
      snapshotSequence: 0,
      updatedAt: at,
    } satisfies OrchestrationReadModel,
  });

it.effect("admits one automatic follow-up and preserves its origin", () =>
  Effect.gen(function* () {
    const result = yield* decide();
    const events = Array.isArray(result) ? result : [result];
    expect(
      events.find((event) => event.type === "thread.turn-start-requested")?.payload,
    ).toMatchObject({ messageOrigin: { kind: "automation" } });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects a stale checkpoint, a running turn and a newer queued human message", () =>
  Effect.gen(function* () {
    for (const change of [
      { latestTurn: { ...thread.latestTurn!, turnId: TurnId.make("newer") } },
      {
        session: {
          ...thread.session!,
          status: "running" as const,
          activeTurnId: TurnId.make("newer"),
        },
      },
      {
        messages: [
          {
            id: MessageId.make("newer-human"),
            role: "user" as const,
            text: "Continue",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: "2026-09-12T10:00:30.000Z",
            updatedAt: "2026-09-12T10:00:30.000Z",
          },
        ],
      },
    ])
      expect((yield* Effect.exit(decide(change)))._tag).toBe("Failure");
  }).pipe(Effect.provide(NodeServices.layer)),
);
