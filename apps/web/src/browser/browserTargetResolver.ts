import type {
  BrowserNavigationTarget,
  EnvironmentId,
  PreviewUrlResolution,
} from "@t3tools/contracts";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";
import { isLocalLoopbackHost, isPrivateNetworkHost } from "@t3tools/shared/hostClassification";

import { readPreparedConnection } from "~/state/session";

export {
  normalizeHostname,
  isLocalLoopbackHost,
  isPrivateNetworkHost,
  isPublicFaviconHost,
} from "@t3tools/shared/hostClassification";

const readEnvironmentUrl = (environmentId: EnvironmentId): URL => {
  const connection = readPreparedConnection(environmentId);
  if (!connection) throw new Error(`Environment ${environmentId} is not connected.`);
  return new URL(connection.httpBaseUrl);
};

const resolveEnvironmentPortTarget = (
  environmentId: EnvironmentId,
  target: Extract<BrowserNavigationTarget, { readonly kind: "environment-port" }>,
  environmentUrl: URL,
): PreviewUrlResolution => {
  if (!isPrivateNetworkHost(environmentUrl.hostname)) {
    throw new Error(
      "This environment port requires an updated desktop host with authenticated Preview routing.",
    );
  }
  const protocol = target.protocol ?? "http";
  const path = target.path?.startsWith("/") ? target.path : `/${target.path ?? ""}`;
  const normalizedEnvironmentHost = environmentUrl.hostname.replace(/^\[|\]$/g, "");
  // Local loopback environments should advertise `localhost` so Chromium
  // dual-stack lookup can reach a Vite server bound only to ::1 or 127.0.0.1.
  const resolvedHost = isLocalLoopbackHost(normalizedEnvironmentHost)
    ? "localhost"
    : normalizedEnvironmentHost.includes(":")
      ? `[${normalizedEnvironmentHost}]`
      : normalizedEnvironmentHost;
  const resolved = new URL(
    previewUrlAtOrigin(`${protocol}://${resolvedHost}:${target.port}`, path),
  );
  return {
    requestedUrl: `${protocol}://localhost:${target.port}${path}`,
    resolvedUrl: resolved.toString(),
    resolutionKind: isLocalLoopbackHost(normalizedEnvironmentHost)
      ? "direct"
      : "direct-private-network",
    environmentId,
  };
};

export function resolveBrowserNavigationTarget(
  environmentId: EnvironmentId,
  target: BrowserNavigationTarget,
): PreviewUrlResolution {
  if (target.kind === "url") {
    return {
      requestedUrl: target.url,
      resolvedUrl: target.url,
      resolutionKind: "direct",
      environmentId,
    };
  }
  return resolveEnvironmentPortTarget(environmentId, target, readEnvironmentUrl(environmentId));
}

/** Ports reported by the environment must never silently fall back to client localhost. */
export function discoveredServerTarget(rawUrl: string): BrowserNavigationTarget {
  const url = new URL(normalizePreviewUrl(rawUrl));
  if (!isLoopbackHost(url.hostname)) return { kind: "url", url: url.href };
  return {
    kind: "environment-port",
    port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    protocol: url.protocol === "https:" ? "https" : "http",
    path: `${url.pathname}${url.search}${url.hash}`,
  };
}

export function previewUrlAtOrigin(origin: string, path = "/"): string {
  // Treat a leading // or backslash as path data, never as another authority.
  const parsed = new URL(`http://localhost/${path.replace(/^\/+/, "").replaceAll("\\", "%5C")}`);
  const resolved = new URL(origin);
  resolved.pathname = parsed.pathname;
  resolved.search = parsed.search;
  resolved.hash = parsed.hash;
  return resolved.href;
}

export async function resolveBrowserTargetWithGateway(
  environmentId: EnvironmentId,
  target: BrowserNavigationTarget,
  createGateway: (
    target: Extract<BrowserNavigationTarget, { kind: "environment-port" }>,
  ) => Promise<string>,
): Promise<PreviewUrlResolution> {
  if (target.kind === "url") return resolveBrowserNavigationTarget(environmentId, target);
  return {
    environmentId,
    requestedUrl: previewUrlAtOrigin(
      `${target.protocol ?? "http"}://localhost:${target.port}`,
      target.path,
    ),
    resolvedUrl: previewUrlAtOrigin(await createGateway(target), target.path),
    resolutionKind: "authenticated-gateway",
  };
}
