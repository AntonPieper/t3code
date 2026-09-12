export * from "./_generated/meta.gen.ts";

import * as Generated from "./_generated/meta.gen.ts";
import { V2TurnStartParams } from "./schema.ts";

export interface ClientRequestParamsByMethod extends Omit<
  Generated.ClientRequestParamsByMethod,
  "turn/start"
> {
  readonly "turn/start": V2TurnStartParams;
}

export const CLIENT_REQUEST_PARAMS = {
  ...Generated.CLIENT_REQUEST_PARAMS,
  "turn/start": V2TurnStartParams,
} as const;
