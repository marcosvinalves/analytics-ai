import { describe, expect, test } from "vitest";
import {
  toBarChartData,
  toLineChartData,
} from "../../src/components/visualizations/chart-data.ts";
import {
  fiveHundredPointBar,
  fiveHundredPointLine,
  revenueByCityBar,
  revenueByDateLine,
} from "../fixtures/visualizations/view-models.ts";

describe("visualization chart adapters", () => {
  test("BAR preserva ordem, duplicatas, NULL e valor autoritativo", () => {
    const before = JSON.stringify(revenueByCityBar);
    const data = toBarChartData(revenueByCityBar);

    expect(data.map((point) => point.categoryLabel)).toEqual([
      "São José dos Campos",
      "Taubaté",
      "Jacareí",
      "Jacareí",
      "Categoria com nome deliberadamente longo para validar o layout",
    ]);
    expect(data[0]).toMatchObject({
      authoritativeValue: "818.7100",
      formattedValue: "818,7100",
      geometryValue: 818.71,
    });
    expect(data[3]).toMatchObject({
      authoritativeValue: null,
      formattedValue: "—",
      geometryValue: null,
    });
    expect(data[4]).toMatchObject({
      authoritativeValue: "900719925474099312345",
      formattedValue: "900.719.925.474.099.312.345",
      geometryValue: null,
    });
    expect(JSON.stringify(revenueByCityBar)).toBe(before);
  });

  test("LINE preserva ordem, timestamp duplicado, NULL e gap sem geometria", () => {
    const before = JSON.stringify(revenueByDateLine);
    const data = toLineChartData(revenueByDateLine);

    expect(data.map((point) => point.x)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-02",
      "2026-08-03",
    ]);
    expect(data[1].geometryValue).toBeNull();
    expect(data[2]).toMatchObject({
      authoritativeValue: "900719925474099312345.0000",
      formattedValue: "900.719.925.474.099.312.345,0000",
      geometryValue: null,
    });
    expect(data[3].exactness).toBe("APPROXIMATE");
    expect(JSON.stringify(revenueByDateLine)).toBe(before);
  });

  test("mantém os 500 pontos sem sort, deduplicação ou truncamento", () => {
    const line = toLineChartData(fiveHundredPointLine());
    const bar = toBarChartData(fiveHundredPointBar());
    expect(line).toHaveLength(500);
    expect(bar).toHaveLength(500);
    expect(line.map((point) => point.index)).toEqual(
      Array.from({ length: 500 }, (_, index) => index),
    );
    expect(bar.map((point) => point.index)).toEqual(
      Array.from({ length: 500 }, (_, index) => index),
    );
    expect(line[250].geometryValue).toBeNull();
    expect(bar[250]).toMatchObject({
      authoritativeValue: "900719925474099312345",
      geometryValue: null,
    });
  });
});
