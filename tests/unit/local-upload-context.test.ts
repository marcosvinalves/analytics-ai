import { afterEach, expect, test, vi } from "vitest";
import {
  localUploadContext,
  checkLocalUploadRequest,
} from "../../src/lib/local-upload-context.ts";

const workspace = "a0000000-0000-4000-8000-000000000000";
afterEach(() => vi.unstubAllEnvs());
function enable() {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("ENABLE_LOCAL_UPLOAD", "true");
  vi.stubEnv("DEV_UPLOAD_WORKSPACE_ID", workspace);
  vi.stubEnv("LOCAL_UPLOAD_ORIGIN", "http://127.0.0.1:3000");
}
test("desabilitado por padrão e sempre em produção", () => {
  vi.stubEnv("ENABLE_LOCAL_UPLOAD", "false");
  expect(localUploadContext()).toBeNull();
  enable();
  vi.stubEnv("NODE_ENV", "production");
  expect(localUploadContext()).toBeNull();
});
test("workspace fixado no servidor e origem exata", () => {
  enable();
  const request = new Request("http://127.0.0.1:3000/upload", {
    headers: { origin: "http://127.0.0.1:3000" },
  });
  expect(checkLocalUploadRequest(workspace, request).workspaceId).toBe(
    workspace,
  );
  expect(() =>
    checkLocalUploadRequest("b0000000-0000-4000-8000-000000000000", request),
  ).toThrow();
  expect(() =>
    checkLocalUploadRequest(
      workspace,
      new Request(request.url, { headers: { origin: "https://evil.example" } }),
    ),
  ).toThrow();
  expect(() =>
    checkLocalUploadRequest(workspace, new Request(request.url)),
  ).toThrow();
  expect(
    checkLocalUploadRequest(
      workspace,
      new Request("http://localhost:3000/upload", {
        headers: { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" },
      }),
    ).workspaceId,
  ).toBe(workspace);
  expect(() =>
    checkLocalUploadRequest(
      workspace,
      new Request(request.url, {
        headers: { origin: "http://127.0.0.1:3000", host: "evil.example" },
      }),
    ),
  ).toThrow();
  vi.stubEnv("LOCAL_UPLOAD_ORIGIN", "https://public.example");
  expect(localUploadContext()).toBeNull();
});
