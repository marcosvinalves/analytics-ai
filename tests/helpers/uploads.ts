export function uploadRequest(
  options: {
    filename?: string;
    mime?: string;
    bytes?: string;
    name?: string;
    extra?: [string, string];
    file?: boolean;
    origin?: string;
    contentLength?: string;
  } = {},
) {
  // Wire-format fixture avoids undici's outbound FormData cancellation race;
  // real HTTP tests also exercise browser-compatible FormData serialization.
  const boundary = "test-multipart-boundary";
  const parts: string[] = [];
  if (options.file !== false)
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${options.filename ?? "vendas.csv"}"\r\nContent-Type: ${options.mime ?? "text/csv"}\r\n\r\n${options.bytes ?? "quantity,price\n2,10\n"}\r\n`,
    );
  for (const [name, value] of [
    ...(options.name !== undefined ? [["name", options.name]] : []),
    ...(options.extra ? [options.extra] : []),
  ]) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    );
  }
  parts.push(`--${boundary}--\r\n`);
  const request = new Request("http://127.0.0.1:3000/upload", {
    method: "POST",
    body: parts.join(""),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  });
  request.headers.set("origin", options.origin ?? "http://127.0.0.1:3000");
  if (options.contentLength)
    request.headers.set("content-length", options.contentLength);
  return request;
}
