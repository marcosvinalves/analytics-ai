import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import {
  prepareWidgetConfiguration,
  rectanglesOverlap,
  validateDashboardWidgetScope,
  validateDashboardWidgetsScope,
  validateSaveDashboardWidgetInput,
  validWidgetLayout,
  type SaveDashboardWidgetInput,
} from "../../src/modules/dashboard/domain/dashboard-widget.ts";

const input: SaveDashboardWidgetInput = {
  workspaceId: randomUUID(),
  dashboardId: randomUUID(),
  semanticModelId: randomUUID(),
  semanticQuery: { version: 1, metrics: [randomUUID()] },
  visualizationSpec: { version: 1, type: "TABLE" },
  layout: { x: 0, y: 0, width: 6, height: 2 },
};

test("valida contratos exatos e configurações canônicas", () => {
  expect(() => validateSaveDashboardWidgetInput(input, false)).not.toThrow();
  expect(() =>
    validateSaveDashboardWidgetInput(
      { ...input, widgetId: randomUUID() },
      true,
    ),
  ).not.toThrow();
  expect(() =>
    validateDashboardWidgetScope({
      workspaceId: input.workspaceId,
      dashboardId: input.dashboardId,
      widgetId: randomUUID(),
    }),
  ).not.toThrow();
  expect(() =>
    validateDashboardWidgetsScope({
      workspaceId: input.workspaceId,
      dashboardId: input.dashboardId,
    }),
  ).not.toThrow();
  expect(prepareWidgetConfiguration(input)).toMatchObject({
    valid: true,
    value: {
      semanticQuery: input.semanticQuery,
      visualizationSpec: input.visualizationSpec,
      layout: input.layout,
    },
  });
});

test.each([
  [{ x: -1, y: 0, width: 1, height: 1 }, false],
  [{ x: 11, y: 0, width: 2, height: 1 }, false],
  [{ x: 0, y: -1, width: 1, height: 1 }, false],
  [{ x: 0, y: 0, width: 0, height: 1 }, false],
  [{ x: 0, y: 2147483647, width: 1, height: 1 }, false],
  [{ x: 11, y: 2147483646, width: 1, height: 1 }, true],
])("revalida limites individuais do layout %#", (layout, expected) => {
  expect(validWidgetLayout(layout)).toBe(expected);
});

test("distingue sobreposição de contato entre retângulos", () => {
  const origin = { x: 0, y: 0, width: 2, height: 2 };
  expect(rectanglesOverlap(origin, { x: 1, y: 1, width: 2, height: 2 })).toBe(
    true,
  );
  expect(rectanglesOverlap(origin, { x: 2, y: 0, width: 1, height: 2 })).toBe(
    false,
  );
});

test.each([
  [{ ...input, semanticQuery: { version: 2 } }, "SEMANTIC_QUERY_INVALID"],
  [
    { ...input, visualizationSpec: { version: 1, type: "UNKNOWN" } },
    "VISUALIZATION_SPEC_INVALID",
  ],
  [
    { ...input, layout: { x: 12, y: 0, width: 1, height: 1 } },
    "LAYOUT_INVALID",
  ],
])(
  "retorna motivo seguro para configuração inválida %#",
  (candidate, reason) => {
    expect(prepareWidgetConfiguration(candidate)).toEqual({
      valid: false,
      reason,
    });
  },
);

test("rejeita UUID ou propriedades externas ao contrato", () => {
  expect(() =>
    validateSaveDashboardWidgetInput(
      { ...input, workspaceId: "invalid" },
      false,
    ),
  ).toThrow(TypeError);
  expect(() =>
    validateSaveDashboardWidgetInput({ ...input, extra: true } as never, false),
  ).toThrow(TypeError);
});
