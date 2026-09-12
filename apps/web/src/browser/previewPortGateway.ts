import type {
  BrowserNavigationTarget,
  EnvironmentId,
  PreviewEnvironmentPort,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { previewBridge } from "~/components/preview/previewBridge";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { previewEnvironment } from "~/state/preview";
import { readPreparedConnection } from "~/state/session";
import {
  previewUrlAtOrigin,
  resolveBrowserNavigationTarget,
  resolveBrowserTargetWithGateway,
} from "./browserTargetResolver";

interface Mapping {
  readonly origin: string;
  readonly environmentPort: PreviewEnvironmentPort;
}
const mappings = new Map<string, Mapping>();

export function forgetPreviewPortGateway(runtimeTabId: string): void {
  mappings.delete(runtimeTabId);
}

export async function resolvePreviewNavigation(
  environmentId: EnvironmentId,
  runtimeTabId: string,
  target: BrowserNavigationTarget,
) {
  if (target.kind === "url") {
    const mapping = mappings.get(runtimeTabId);
    const url = URL.parse(target.url);
    if (
      mapping &&
      url &&
      url.origin ===
        new URL(`${mapping.environmentPort.protocol}://localhost:${mapping.environmentPort.port}`)
          .origin
    ) {
      target = {
        kind: "environment-port",
        ...mapping.environmentPort,
        path: `${url.pathname}${url.search}${url.hash}`,
      };
    }
  }
  if (target.kind === "url" || !previewBridge?.createPortGateway) {
    return resolveBrowserNavigationTarget(environmentId, target);
  }
  return resolveBrowserTargetWithGateway(environmentId, target, async (portTarget) => {
    const connection = readPreparedConnection(environmentId);
    if (!connection) throw new Error("This environment is disconnected.");
    const environmentPort = {
      port: portTarget.port,
      protocol: portTarget.protocol ?? "http",
    } as const;
    const grant = await previewEnvironment.createPortGateway.run(appAtomRegistry, {
      environmentId,
      input: environmentPort,
    });
    if (grant._tag === "Failure") throw squashAtomCommandFailure(grant);
    const origin = await previewBridge!.createPortGateway!({
      tabId: runtimeTabId,
      environmentId,
      ...environmentPort,
      gatewayUrl: new URL(grant.value.relativeUrl, connection.httpBaseUrl).href,
      expiresAt: grant.value.expiresAt,
    });
    mappings.set(runtimeTabId, { origin, environmentPort });
    return origin;
  });
}

/** Keep ephemeral desktop addresses out of server state, history and other clients. */
export function describePreviewUrl(runtimeTabId: string, url: string) {
  const mapping = mappings.get(runtimeTabId);
  const parsed = URL.parse(url);
  if (!mapping || parsed?.origin !== mapping.origin) return { url, environmentPort: null };
  const { port, protocol } = mapping.environmentPort;
  return {
    url: previewUrlAtOrigin(
      `${protocol}://localhost:${port}`,
      `${parsed.pathname}${parsed.search}${parsed.hash}`,
    ),
    environmentPort: mapping.environmentPort,
  };
}

export function previewPhysicalUrl(runtimeTabId: string, url: string): string {
  const mapping = mappings.get(runtimeTabId);
  const parsed = URL.parse(url);
  if (
    !mapping ||
    !parsed ||
    parsed.origin !==
      new URL(`${mapping.environmentPort.protocol}://localhost:${mapping.environmentPort.port}`)
        .origin
  )
    return url;
  return previewUrlAtOrigin(mapping.origin, `${parsed.pathname}${parsed.search}${parsed.hash}`);
}
