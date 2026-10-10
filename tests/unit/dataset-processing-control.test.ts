import { expect, test, vi } from "vitest";

vi.mock("@/app/data/datasets/[datasetId]/actions", () => ({
  processDatasetAction: vi.fn(),
}));
vi.mock("@/components/ui/action", () => ({ Button: vi.fn() }));

import { processingControlView } from "../../src/components/data/dataset-processing-control.tsx";

test("pending desabilita o botão e fornece feedback acessível", () => {
  expect(processingControlView(true, { outcome: "IDLE" })).toEqual({
    disabled: true,
    label: "Processando dados…",
    message: "Processamento em andamento. Você pode continuar navegando.",
  });
});

test("feedback usa somente a mensagem segura da action", () => {
  expect(
    processingControlView(false, {
      outcome: "OPERATIONAL_FAILURE",
      code: "PROCESSING_OUTCOME_UNKNOWN",
      message: "Atualize a página antes de tentar novamente.",
    }),
  ).toEqual({
    disabled: false,
    label: "Processar dados",
    message: "Atualize a página antes de tentar novamente.",
  });
});
