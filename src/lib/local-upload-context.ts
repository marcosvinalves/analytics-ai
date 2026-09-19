import { UploadError } from "../modules/dataset/application/upload-errors.ts";

/** TEMPORARY LOCAL SCAFFOLDING: NOT authentication, authorization or tenant security. */
export function localUploadContext() {
  if (
    process.env.NODE_ENV !== "development" ||
    process.env.ENABLE_LOCAL_UPLOAD !== "true"
  )
    return null;
  const workspaceId = process.env.DEV_UPLOAD_WORKSPACE_ID;
  if (
    !workspaceId ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(workspaceId)
  )
    return null;
  try {
    const origin = new URL(
      process.env.LOCAL_UPLOAD_ORIGIN || "http://127.0.0.1:3000",
    );
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) ||
      origin.protocol !== "http:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      return null;
    return { workspaceId: workspaceId.toLowerCase(), origin: origin.origin };
  } catch {
    return null;
  }
}

export function checkLocalUploadRequest(workspaceId: string, request: Request) {
  const context = localUploadContext();
  if (!context || context.workspaceId !== workspaceId.toLowerCase()) {
    throw new UploadError(
      "UPLOAD_UNAVAILABLE",
      404,
      "Upload local indisponível.",
    );
  }
  if (
    request.headers.get("origin") !== context.origin ||
    // Next.js may normalize request.url to localhost; Host retains the HTTP destination.
    (request.headers.get("host") ?? new URL(request.url).host) !==
      new URL(context.origin).host
  ) {
    throw new UploadError(
      "ORIGIN_NOT_ALLOWED",
      403,
      "Origem da requisição não permitida.",
    );
  }
  return context;
}
