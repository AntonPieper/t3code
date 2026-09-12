import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const readPreparedConnection = vi.fn();

vi.mock("~/state/session", () => ({ readPreparedConnection }));

describe("browser target resolver", () => {
  beforeEach(() => readPreparedConnection.mockReset());

  it("maps environment ports onto a private network host", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://192.168.1.25:3773" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
        path: "/dashboard",
      }),
    ).toEqual({
      requestedUrl: "http://localhost:5173/dashboard",
      resolvedUrl: "http://192.168.1.25:5173/dashboard",
      resolutionKind: "direct-private-network",
      environmentId: "environment-1",
    });
  });

  it("preserves explicit loopback URL navigation for a remote Tailscale environment", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://100.65.180.100:3773" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "http://localhost:5173/dashboard?mode=test#results",
      }),
    ).toEqual({
      requestedUrl: "http://localhost:5173/dashboard?mode=test#results",
      resolvedUrl: "http://localhost:5173/dashboard?mode=test#results",
      resolutionKind: "direct",
      environmentId: "environment-1",
    });
  });

  it("preserves explicit IPv4 loopback URL navigation for a private network environment", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://192.168.1.50:3773" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "http://127.0.0.1:5999/",
      }),
    ).toEqual({
      requestedUrl: "http://127.0.0.1:5999/",
      resolvedUrl: "http://127.0.0.1:5999/",
      resolutionKind: "direct",
      environmentId: "environment-1",
    });
  });

  it("preserves URL credentials on explicit loopback navigation", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://100.65.180.100:3773" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "http://user:p%40ss@localhost:5173/dashboard",
      }).resolvedUrl,
    ).toBe("http://user:p%40ss@localhost:5173/dashboard");
  });

  it("preserves credentialed loopback URLs for private IPv6 environments", async () => {
    readPreparedConnection.mockReturnValue({
      httpBaseUrl: "http://[fd7a:115c:a1e0::53]:3773",
    });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "http://user:p%40ss@localhost:5173/dashboard?mode=test#results",
      }).resolvedUrl,
    ).toBe("http://user:p%40ss@localhost:5173/dashboard?mode=test#results");
  });

  it("preserves schemeless localhost navigation for a remote environment", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://192.168.1.25:3773" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "localhost:3000/app",
      }).resolvedUrl,
    ).toBe("localhost:3000/app");
  });

  it("keeps localhost navigation local for a local environment", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://127.0.0.1:3773" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "localhost:3000/app",
      }),
    ).toEqual({
      requestedUrl: "localhost:3000/app",
      resolvedUrl: "localhost:3000/app",
      resolutionKind: "direct",
      environmentId: "environment-1",
    });
  });

  it("keeps localhost navigation local for the full IPv4 loopback range", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://127.0.0.2:3773" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "http://localhost:3000/app",
      }),
    ).toEqual({
      requestedUrl: "http://localhost:3000/app",
      resolvedUrl: "http://localhost:3000/app",
      resolutionKind: "direct",
      environmentId: "environment-1",
    });
  });

  it("requires a gateway-capable desktop for a public relay", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "https://relay.example.com" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(() =>
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
      }),
    ).toThrow(/authenticated Preview routing/);
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "http://localhost:5173",
      }),
    ).toMatchObject({ resolvedUrl: "http://localhost:5173", resolutionKind: "direct" });
  });

  it("supports private IPv6 environment hosts", async () => {
    readPreparedConnection.mockReturnValue({
      httpBaseUrl: "http://[fd7a:115c:a1e0::53]:3773",
    });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
        path: "/app?mode=test",
      }).resolvedUrl,
    ).toBe("http://[fd7a:115c:a1e0::53]:5173/app?mode=test");
  });

  it("supports a local IPv6 environment host", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://[::1]:3773" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
      }).resolvedUrl,
    ).toBe("http://localhost:5173/");
  });

  it("maps local IPv4 environment ports onto localhost for dual-stack guests", async () => {
    readPreparedConnection.mockReturnValue({ httpBaseUrl: "http://127.0.0.1:3773" });
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
        path: "/app",
      }).resolvedUrl,
    ).toBe("http://localhost:5173/app");
  });

  it.each(["http://localhost:3773", "http://100.65.1.2:3773", "https://relay.example.com"])(
    "routes ports through the authenticated gateway for %s",
    async (httpBaseUrl) => {
      readPreparedConnection.mockReturnValue({ httpBaseUrl });
      const { resolveBrowserTargetWithGateway, discoveredServerTarget, previewUrlAtOrigin } =
        await import("./browserTargetResolver");
      const target = discoveredServerTarget("localhost:5173/app?mode=test#top");
      const resolve = vi.fn(async () => "http://127.0.0.1:43210");
      expect(
        await resolveBrowserTargetWithGateway(EnvironmentId.make("environment-1"), target, resolve),
      ).toMatchObject({
        requestedUrl: "http://localhost:5173/app?mode=test#top",
        resolvedUrl: "http://127.0.0.1:43210/app?mode=test#top",
        resolutionKind: "authenticated-gateway",
      });
      expect(resolve).toHaveBeenCalledOnce();
      expect(
        new URL(previewUrlAtOrigin("http://127.0.0.1:43210", "//elsewhere.test/path")).origin,
      ).toBe("http://127.0.0.1:43210");
      await expect(
        resolveBrowserTargetWithGateway(EnvironmentId.make("environment-1"), target, async () => {
          throw new Error("disconnected");
        }),
      ).rejects.toThrow("disconnected");
      expect(discoveredServerTarget("example.com/app")).toEqual({
        kind: "url",
        url: "https://example.com/app",
      });
    },
  );

  it("classifies exact private IPv4 and IPv6 boundaries", async () => {
    const { isPrivateNetworkHost } = await import("./browserTargetResolver");
    const privateHosts = [
      "0.0.0.0",
      "10.0.0.0",
      "10.255.255.255",
      "100.64.0.0",
      "100.127.255.255",
      "127.0.0.0",
      "127.255.255.255",
      "169.254.0.0",
      "169.254.255.255",
      "172.16.0.0",
      "172.31.255.255",
      "192.168.0.0",
      "192.168.255.255",
      "198.18.0.0",
      "198.19.255.255",
      "fc00::",
      "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "fe80::",
      "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "::ffff:192.168.1.1",
      "localhost.",
      "localhost..",
      "devbox.",
      "devbox..",
      "printer.local.",
      "printer.local..",
      "printer.home.arpa.",
      "printer.home.arpa..",
      "devbox.example.ts.net.",
      "devbox.example.ts.net..",
    ];
    const publicHosts = [
      "1.0.0.0",
      "100.63.255.255",
      "100.128.0.0",
      "169.253.255.255",
      "169.255.0.0",
      "172.15.255.255",
      "172.32.0.0",
      "192.167.255.255",
      "192.169.0.0",
      "198.17.255.255",
      "198.20.0.0",
      "fbff:ffff::",
      "fec0::",
      "2001:4860:4860::8888",
      "::ffff:8.8.8.8",
      "example.com.",
    ];
    expect(privateHosts.filter((host) => !isPrivateNetworkHost(host))).toEqual([]);
    expect(publicHosts.filter(isPrivateNetworkHost)).toEqual([]);
  });

  it("allows only globally routable hosts to reach a public favicon provider", async () => {
    const { isPublicFaviconHost } = await import("./browserTargetResolver");
    const nonPublic = [
      "192.0.0.0",
      "192.0.0.255",
      "192.0.2.0",
      "192.0.2.255",
      "192.88.99.0",
      "192.88.99.255",
      "198.51.100.0",
      "198.51.100.255",
      "203.0.113.0",
      "203.0.113.255",
      "224.0.0.0",
      "255.255.255.255",
      "::2",
      "100::",
      "100::ffff:ffff:ffff:ffff",
      "100:0:0:1::",
      "100:0:0:1:ffff:ffff:ffff:ffff",
      "64:ff9b:1::1",
      "64:ff9b::a00:1",
      "64:ff9b::7f00:1",
      "64:ff9b::c0a8:101",
      "64:ff9b::c000:201",
      "2001:5::1",
      "2001:2::",
      "2001:2:0:ffff:ffff:ffff:ffff:ffff",
      "2001:db8::",
      "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
      "3fff::",
      "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff",
      "5f00::1",
      "fec0::",
      "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "::ffff:192.0.2.1",
      "app.test",
      "app.test..",
      "printer.local..",
      "printer.home.arpa..",
      "devbox.example.ts.net..",
      "127.0.0.1..",
      "127.1..",
      "10.1..",
      "172.16.1..",
      "192.168.1..",
      "service.internal",
      "hidden.onion",
    ];
    const publicHosts = [
      "191.255.255.255",
      "192.0.1.255",
      "192.0.3.0",
      "198.51.99.255",
      "198.51.101.0",
      "203.0.112.255",
      "203.0.114.0",
      "223.255.255.255",
      "1.1.1.1",
      "2001:4860:4860::8888",
      "2606:4700:4700::1111",
      "64:ff9b::808:808",
      "2001:1::1",
      "2001:3::1",
      "2001:4:112::1",
      "2001:20::1",
      "2001:30::1",
      "::ffff:8.8.8.8",
      "example.com",
      "example.com.",
    ];
    expect(nonPublic.filter(isPublicFaviconHost)).toEqual([]);
    expect(publicHosts.filter((host) => !isPublicFaviconHost(host))).toEqual([]);
  });
});
