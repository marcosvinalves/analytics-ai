import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { DatasetDetailView } from "../../src/components/data/dataset-detail.tsx";
import type { DatasetDetail } from "../../src/modules/dataset/domain/dataset-detail.ts";

const detail: DatasetDetail = {
  dataset: {
    id: "test",
    name: "<script>private()</script>",
    description: null,
  },
  version: {
    id: "v",
    versionNumber: 1,
    status: "READY",
    rowCount: "1",
    columnCount: 1,
    originalFilename: "x.csv",
    sizeBytes: "12",
    processedAt: null,
  },
  columns: [
    {
      physicalName: "value",
      inferredType: "VARCHAR",
      ordinalPosition: 1,
      nullable: null,
      nullCount: "0",
    },
  ],
  preview: {
    state: "AVAILABLE",
    limit: 50,
    rows: [[{ column: "value", value: "<img src=x onerror=alert(1)>" }]],
  },
};
test("preview renders escaped text and unknown nullability without client JS", () => {
  const html = renderToStaticMarkup(
    createElement(DatasetDetailView, { detail }),
  );
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;img");
  expect(html).toContain("Desconhecido");
  expect(html).toContain("1 linhas exibidas");
});
test.each(["PROCESSING", "FAILED"] as const)(
  "%s hides preview/schema",
  (status) => {
    const html = renderToStaticMarkup(
      createElement(DatasetDetailView, {
        detail: {
          ...detail,
          version: { ...detail.version, status },
          preview: { state: "UNAVAILABLE" },
        },
      }),
    );
    expect(html).not.toContain("<table>");
    expect(html).toContain(
      status === "FAILED"
        ? "Não foi possível processar"
        : "Aguardando conclusão",
    );
  },
);
