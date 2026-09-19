import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { UploadForm } from "../../src/components/data/upload-form.tsx";

test("HTML inicial impede envio antes da hidratação e não usa GET", () => {
  const html = renderToStaticMarkup(
    createElement(UploadForm, {
      workspaceId: "a0000000-0000-4000-8000-000000000000",
      maxBytes: 10485760,
    }),
  );
  expect(html).toMatch(/<button[^>]*disabled=""/);
  expect(html).toMatch(/<input[^>]*type="file"[^>]*disabled=""/);
  expect(html).toContain('method="post"');
  expect(html).toContain('encType="multipart/form-data"');
  expect(html).toContain("Ative o JavaScript");
});
