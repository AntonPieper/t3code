import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    mcpServers: Schema.Struct({
      cua_repl: Schema.Struct({
        command: Schema.String,
        args: Schema.Array(Schema.String),
        env: Schema.Record(Schema.String, Schema.String),
      }),
    }),
  }),
);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Uses the user's installed, unchanged CUA launcher and native runtime settings. */
export const loadCodexCuaConfiguration = Effect.fn("loadCodexCuaConfiguration")(function* (
  manifestPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const {
    mcpServers: { cua_repl: installed },
  } = yield* fs.readFileString(manifestPath).pipe(Effect.flatMap(Schema.decodeEffect(Manifest)));
  const launcher = installed.args.find(
    (arg) => path.isAbsolute(arg) && arg.endsWith("/cua-repl.mjs"),
  );
  if (!launcher || !(yield* fs.exists(launcher)) || !(yield* fs.exists(installed.command))) {
    return yield* new CuaConfigurationError({
      message: "The selected CUA plugin does not reference an installed cua-repl launcher.",
    });
  }
  const version = yield* fs
    .readFileString(path.resolve(launcher, "../../package.json"))
    .pipe(
      Effect.flatMap(
        Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({ name: Schema.Literal("@oai/cua-repl"), version: Schema.String }),
          ),
        ),
      ),
    );
  if (version.version !== "0.1.0")
    return yield* new CuaConfigurationError({
      message: `CUA runtime ${version.version} has not been verified with this Preview adapter. Disable the opt-in or select a compatible installed plugin.`,
    });
  const env = {
    ...installed.env,
    CUA_REPL_ENABLED_SURFACES: "browser",
    BROWSER_USE_AVAILABLE_BACKENDS: "iab",
    // T3 identifies its own host; it must not claim to be a Codex Desktop build.
    BROWSER_USE_CODEX_APP_BUILD_FLAVOR: "",
    BROWSER_USE_CODEX_APP_VERSION: "",
  };
  const config = {
    'plugins."unified-computer-use@openai-bundled".enabled': false,
    "mcp_servers.cua_repl.command": installed.command,
    "mcp_servers.cua_repl.args": installed.args,
    ...Object.fromEntries(
      Object.entries(env).map(([key, value]) => [`mcp_servers.cua_repl.env.${key}`, value]),
    ),
    "mcp_servers.cua_repl.enabled_tools": ["js", "js_reset", "turn_ended"],
    "mcp_servers.cua_repl.startup_timeout_sec": 120,
    "mcp_servers.cua_repl.omit_tools_from": ["code_mode", "deferred"],
    "mcp_servers.t3-code.disabled_tools": [
      "preview_status",
      "preview_open",
      "preview_navigate",
      "preview_resize",
      "preview_set_appearance",
      "preview_snapshot",
      "preview_click",
      "preview_type",
      "preview_press",
      "preview_scroll",
      "preview_evaluate",
      "preview_wait_for",
    ],
  };
  return {
    version: version.version,
    appServerArgs: Object.entries(config).flatMap(([key, value]) => [
      "-c",
      `${key}=${encode(value)}`,
    ]),
  };
});

export class CuaConfigurationError extends Schema.TaggedError<CuaConfigurationError>()(
  "CuaConfigurationError",
  { message: Schema.String },
) {}
