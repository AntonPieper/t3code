export * from "./_generated/schema.gen.ts";
export * from "./_generated/meta.gen.ts";
export * from "./_generated/namespaces.gen.ts";

import * as Schema from "effect/Schema";
import * as Generated from "./_generated/schema.gen.ts";

/** Opt-in fields omitted from upstream's stable bundle; verified with Codex 0.154. */
export const V2TurnStartParams = Generated.V2TurnStartParams.pipe(
  Schema.fieldsAssign({
    collaborationMode: Schema.optionalKey(Generated.V2TurnStartParams__CollaborationMode),
    additionalContext: Schema.optionalKey(
      Schema.NullOr(
        Schema.Record(Schema.String, Generated.V2TurnStartParams__AdditionalContextEntry),
      ),
    ),
  }),
);
export type V2TurnStartParams = typeof V2TurnStartParams.Type;
