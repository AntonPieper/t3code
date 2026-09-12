import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as CodexClient from "effect-codex-app-server/client";
import { buildCodexInitializeParams } from "../provider/Layers/CodexProvider.ts";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  type CodexSettings,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  type ModelSelection,
  type ServerProviderModel,
  TextGenerationError,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { codexExecLaunchArgs, resolveCodexLaunchArgs } from "../provider/Layers/codexLaunchArgs.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";
import { codexModelFamily, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";

const CODEX_TIMEOUT_MS = 180_000;
const decodeMcpRegistrations = Schema.decodeUnknownEffect(
  Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
);
/**
 * Build a Codex text-generation closure bound to a specific `CodexSettings`
 * payload. See `makeCodexAdapter` for the overall per-instance rationale.
 */
export const makeCodexTextGeneration = Effect.fn("makeCodexTextGeneration")(function* (
  codexConfig: CodexSettings,
  environment?: NodeJS.ProcessEnv,
  getModels: Effect.Effect<ReadonlyArray<ServerProviderModel>> = Effect.succeed([]),
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig.ServerConfig);
  const resolvedEnvironment = environment ?? process.env;

  type MaterializedImageAttachments = {
    readonly imagePaths: ReadonlyArray<string>;
  };

  const materializeImageAttachments = Effect.fn("materializeImageAttachments")(function* (
    _operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle",
    attachments: TextGeneration.BranchNameGenerationInput["attachments"],
  ): Effect.fn.Return<MaterializedImageAttachments, TextGenerationError> {
    if (!attachments || attachments.length === 0) {
      return { imagePaths: [] };
    }

    const imagePaths: string[] = [];
    for (const attachment of attachments) {
      if (attachment.type !== "image") {
        continue;
      }

      const resolvedPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!resolvedPath || !path.isAbsolute(resolvedPath)) {
        continue;
      }
      const fileInfo = yield* fileSystem.stat(resolvedPath).pipe(Effect.orElseSucceed(() => null));
      if (!fileInfo || fileInfo.type !== "File") {
        continue;
      }
      imagePaths.push(resolvedPath);
    }
    return { imagePaths };
  });

  const runCodexJson = Effect.fn("CodexTextGeneration.runCodexJson")(function* <
    S extends Schema.Top,
  >({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    imagePaths = [],
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    imagePaths?: ReadonlyArray<string>;
    modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const generate = Effect.gen(function* () {
      const suppliedContextOnly =
        operation === "generateThreadTitle" || operation === "generateBranchName";
      const workingDirectory = suppliedContextOnly
        ? yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-codex-metadata-" })
        : cwd;
      const models = yield* getModels;
      const requestedModel = modelSelection.model;
      const model =
        models.find((candidate) => candidate.slug === requestedModel)?.slug ??
        models.find(
          (candidate) => !candidate.isCustom && codexModelFamily(candidate.slug) === requestedModel,
        )?.slug ??
        requestedModel;
      const launchArgs = resolveCodexLaunchArgs(codexConfig.launchArgs, resolvedEnvironment);
      const spawnCommand = yield* resolveSpawnCommand(
        codexConfig.binaryPath || "codex",
        ["app-server", ...codexExecLaunchArgs(launchArgs)],
        { env: resolvedEnvironment },
      );
      const child = yield* commandSpawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: {
            ...resolvedEnvironment,
            ...(codexConfig.homePath ? { CODEX_HOME: expandHomePath(codexConfig.homePath) } : {}),
          },
          cwd: workingDirectory,
          shell: spawnCommand.shell,
          forceKillAfter: "2 seconds",
        }),
      );
      return yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        yield* client.request("initialize", buildCodexInitializeParams());
        yield* client.notify("initialized", undefined);
        const { config } = yield* client.request("config/read", {
          cwd: workingDirectory,
          includeLayers: false,
        });
        // Empty TOML tables merge with inherited entries. Disable each effective registration.
        const mcp = yield* decodeMcpRegistrations(config.mcp_servers ?? {});
        const metadataConfig = {
          mcp_servers: Object.fromEntries(
            Object.entries(mcp).map(([name, registration]) => [
              name,
              {
                ...Object.fromEntries(
                  Object.entries(registration).filter(([, value]) => value !== null),
                ),
                enabled: false,
              },
            ]),
          ),
          "features.plugins": false,
          "features.apps": false,
          "features.hooks": false,
          "features.browser_use": false,
          "features.computer_use": false,
          web_search: "disabled",
          ...(suppliedContextOnly
            ? {
                "features.shell_tool": false,
                project_doc_max_bytes: 0,
                "skills.include_instructions": false,
              }
            : {}),
        };
        const opened = yield* client.request("thread/start", {
          cwd: workingDirectory,
          model,
          ephemeral: true,
          approvalPolicy: "never",
          sandbox: "read-only",
          config: metadataConfig,
        });
        const completion = yield* Deferred.make<string, TextGenerationError>();
        let answer = "";
        yield* client.handleServerNotification("item/completed", (event) =>
          Effect.sync(() => {
            if (event.threadId === opened.thread.id && event.item.type === "agentMessage")
              answer = event.item.text;
          }),
        );
        yield* client.handleServerNotification("turn/completed", (event) => {
          if (event.threadId !== opened.thread.id) return Effect.void;
          return (
            event.turn.status === "completed"
              ? Deferred.succeed(completion, answer)
              : Deferred.fail(
                  completion,
                  new TextGenerationError({
                    operation,
                    detail:
                      event.turn.error?.message ??
                      `Codex metadata generation ${event.turn.status}.`,
                  }),
                )
          ).pipe(Effect.asVoid);
        });
        const serviceTier = getCodexServiceTierOptionValue(modelSelection);
        yield* client.request("turn/start", {
          threadId: opened.thread.id,
          input: [
            { type: "text", text: prompt },
            ...imagePaths.map((path) => ({ type: "localImage" as const, path })),
          ],
          model,
          effort:
            getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
            DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
          ...(serviceTier ? { serviceTier } : {}),
          outputSchema: toJsonSchemaObject(outputSchemaJson),
        });
        return yield* Deferred.await(completion);
      }).pipe(Effect.provide(CodexClient.layerChildProcess(child)));
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        normalizeCliError(
          "codex",
          operation,
          cause,
          `Codex metadata request failed: ${cause.message}`,
        ),
      ),
      Effect.timeoutOption(CODEX_TIMEOUT_MS),
    );
    const output = yield* generate;
    if (Option.isNone(output))
      return yield* new TextGenerationError({
        operation,
        detail: "Codex metadata request timed out.",
      });
    return yield* Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson))(output.value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Codex returned invalid structured output.",
            cause,
          }),
      ),
    );
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("CodexTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runCodexJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("CodexTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runCodexJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("CodexTextGeneration.generateBranchName")(function* (input) {
      const { imagePaths } = yield* materializeImageAttachments(
        "generateBranchName",
        input.attachments,
      );
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runCodexJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        imagePaths,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("CodexTextGeneration.generateThreadTitle")(function* (input) {
      const { imagePaths } = yield* materializeImageAttachments(
        "generateThreadTitle",
        input.attachments,
      );
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });

      const generated = yield* runCodexJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        imagePaths,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
