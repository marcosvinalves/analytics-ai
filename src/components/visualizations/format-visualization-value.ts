import type {
  CategoricalVisualizationValue,
  NumericVisualizationValue,
  TemporalVisualizationValue,
} from "@/modules/dashboard/domain/visualization-mapping";
import type { QueryValue } from "@/modules/query/domain/query-result";

export type FormattedVisualizationValue = Readonly<{
  text: string;
  accessibleText: string;
  exactness?: "EXACT" | "APPROXIMATE";
}>;

function groupInteger(value: string): string {
  const sign = value.startsWith("-") ? "-" : "";
  const digits = sign ? value.slice(1) : value;
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

export function formatInteger(value: string): string {
  return groupInteger(value);
}

export function formatDecimal(value: string): string {
  const [integer, fraction] = value.split(".");
  return fraction === undefined
    ? groupInteger(integer)
    : `${groupInteger(integer)},${fraction}`;
}

export function formatNumber(value: string): string {
  const match = /^(.*?)([eE][+-]?\d+)?$/.exec(value);
  if (!match) return value;
  return `${formatDecimal(match[1])}${match[2] ?? ""}`;
}

export function formatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

function formatTimestamp(value: string, instant: boolean): string {
  const suffix = instant && value.endsWith("Z") ? " UTC" : "";
  const body = instant && value.endsWith("Z") ? value.slice(0, -1) : value;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(.+)$/.exec(body);
  if (!match) return value;
  return `${match[3]}/${match[2]}/${match[1]} ${match[4].replace(".", ",")}${suffix}`;
}

export function formatDateTime(value: string): string {
  return formatTimestamp(value, false);
}

export function formatInstant(value: string): string {
  return formatTimestamp(value, true);
}

export function formatBoolean(value: boolean): string {
  return value ? "Sim" : "Não";
}

function nullValue(): FormattedVisualizationValue {
  return { text: "—", accessibleText: "Sem valor" };
}

export function formatNumericVisualizationValue(
  value: NumericVisualizationValue,
): FormattedVisualizationValue {
  if (value.type === "NULL") return nullValue();
  const text =
    value.type === "INTEGER"
      ? formatInteger(value.value)
      : value.type === "DECIMAL"
        ? formatDecimal(value.value)
        : formatNumber(value.value);
  return { text, accessibleText: text, exactness: value.exactness };
}

export function formatCategoricalVisualizationValue(
  value: CategoricalVisualizationValue,
): FormattedVisualizationValue {
  if (value.type === "NULL") return nullValue();
  if (value.type === "BOOLEAN") {
    const text = formatBoolean(value.value);
    return { text, accessibleText: text };
  }
  if (value.value === "") return { text: "“”", accessibleText: "Texto vazio" };
  return { text: value.value, accessibleText: value.value };
}

export function formatTemporalVisualizationValue(
  value: TemporalVisualizationValue,
): FormattedVisualizationValue {
  if (value.type === "NULL") return nullValue();
  const text =
    value.type === "DATE"
      ? formatDate(value.value)
      : value.type === "DATETIME"
        ? formatDateTime(value.value)
        : formatInstant(value.value);
  return { text, accessibleText: text };
}

export function formatQueryValue(
  value: QueryValue,
): FormattedVisualizationValue {
  if (value.type === "NULL") return nullValue();
  if (value.type === "STRING") {
    if (value.value === "")
      return { text: "“”", accessibleText: "Texto vazio" };
    return { text: value.value, accessibleText: value.value };
  }
  if (value.type === "BOOLEAN") {
    const text = formatBoolean(value.value);
    return { text, accessibleText: text };
  }
  if (value.type === "INTEGER") {
    const text = formatInteger(value.value);
    return { text, accessibleText: text, exactness: "EXACT" };
  }
  if (value.type === "DECIMAL") {
    const text = formatDecimal(value.value);
    return { text, accessibleText: text, exactness: "EXACT" };
  }
  if (value.type === "NUMBER") {
    const text = formatNumber(value.value);
    return { text, accessibleText: text, exactness: "APPROXIMATE" };
  }
  if (value.type === "DATE") {
    const text = formatDate(value.value);
    return { text, accessibleText: text };
  }
  if (value.type === "DATETIME") {
    const text = formatDateTime(value.value);
    return { text, accessibleText: text };
  }
  const text = formatInstant(value.value);
  return { text, accessibleText: text };
}
