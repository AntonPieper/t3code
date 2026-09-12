import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { resolvePreviewNavigation, forgetPreviewPortGateway } from "./previewPortGateway";
const mocks = vi.hoisted(() => ({
  grant: vi.fn(async () => ({
    _tag: "Success",
    value: { relativeUrl: "/api/preview-port/fixture", expiresAt: 9999999999999 },
  })),
  create: vi.fn(async () => "http://preview-fixture.localhost:4567"),
}));
vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: { createPortGateway: mocks.create },
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("~/state/preview", () => ({
  previewEnvironment: { createPortGateway: { run: mocks.grant } },
}));
vi.mock("~/state/session", () => ({
  readPreparedConnection: () => ({ httpBaseUrl: "https://remote.example" }),
}));
describe("environment-port navigation", () => {
  it("refreshes routing for canonical URL bar and history paths without redirecting unrelated URLs", async () => {
    const environmentId = EnvironmentId.make("remote");
    await resolvePreviewNavigation(environmentId, "tab", { kind: "environment-port", port: 5173 });
    const next = await resolvePreviewNavigation(environmentId, "tab", {
      kind: "url",
      url: "http://localhost:5173/settings?q=1#profile",
    });
    expect(next.resolvedUrl).toBe("http://preview-fixture.localhost:4567/settings?q=1#profile");
    expect(next.resolutionKind).toBe("authenticated-gateway");
    expect(mocks.grant).toHaveBeenCalledTimes(2);
    const direct = await resolvePreviewNavigation(environmentId, "tab", {
      kind: "url",
      url: "https://example.com/page",
    });
    expect(direct.resolvedUrl).toBe("https://example.com/page");
    expect(mocks.grant).toHaveBeenCalledTimes(2);
    forgetPreviewPortGateway("tab");
  });
});
