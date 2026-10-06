import { describe, expect, test } from "vitest";
import {
  formatBoolean,
  formatDate,
  formatDateTime,
  formatDecimal,
  formatInstant,
  formatInteger,
  formatNumber,
  formatNumericVisualizationValue,
  formatQueryValue,
} from "../../src/components/visualizations/format-visualization-value.ts";

describe("visualization formatters", () => {
  test("formata INTEGER e DECIMAL pela string autoritativa", () => {
    expect(formatInteger("9007199254740993")).toBe("9.007.199.254.740.993");
    expect(formatInteger("-1200")).toBe("-1.200");
    expect(formatDecimal("2059.6100")).toBe("2.059,6100");
    expect(formatDecimal("-0.0100")).toBe("-0,0100");
  });

  test("localiza NUMBER lexicalmente sem converter para JavaScript number", () => {
    expect(formatNumber("1.25")).toBe("1,25");
    expect(formatNumber("1.2345678901234568e+30")).toBe(
      "1,2345678901234568e+30",
    );
    expect(
      formatNumericVisualizationValue({
        type: "NUMBER",
        value: "1.25",
        exactness: "APPROXIMATE",
        geometryValue: 1.25,
      }),
    ).toEqual({
      text: "1,25",
      accessibleText: "1,25",
      exactness: "APPROXIMATE",
    });
  });

  test("formata temporais sem Date ou timezone inventado", () => {
    expect(formatDate("2024-02-29")).toBe("29/02/2024");
    expect(formatDateTime("2024-01-02T03:04:05.1234")).toBe(
      "02/01/2024 03:04:05,1234",
    );
    expect(formatInstant("2024-01-02T03:04:05.1234Z")).toBe(
      "02/01/2024 03:04:05,1234 UTC",
    );
  });

  test("formata BOOLEAN, NULL, texto vazio e demais QueryValues", () => {
    expect(formatBoolean(true)).toBe("Sim");
    expect(formatBoolean(false)).toBe("Não");
    expect(formatQueryValue({ type: "NULL" })).toEqual({
      text: "—",
      accessibleText: "Sem valor",
    });
    expect(formatQueryValue({ type: "STRING", value: "" })).toEqual({
      text: "“”",
      accessibleText: "Texto vazio",
    });
    expect(formatQueryValue({ type: "BOOLEAN", value: true }).text).toBe("Sim");
  });
});
