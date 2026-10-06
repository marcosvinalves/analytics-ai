import type { CSSProperties } from "react";
import type {
  DashboardExecutionItem,
  ExecuteDashboardResult,
} from "../../modules/dashboard/application/execute-dashboard";
import type { ExecuteDashboardWidgetResult } from "../../modules/dashboard/application/execute-dashboard-widget";
import type { VisualizationViewModel } from "../../modules/dashboard/domain/visualization-mapping";
import { VisualizationRenderer } from "../visualizations/visualization-renderer";
import { ExplanationDrawer } from "./explanation-drawer";
import { RefreshButton } from "./refresh-button";
import styles from "./dashboard.module.css";

type CompletedDashboard = Extract<
  ExecuteDashboardResult,
  { status: "COMPLETED" | "CANCELLED" }
>;

type WidgetStyle = CSSProperties & { "--tablet-span": number };

type Message = Readonly<{
  title: string;
  description: string;
  retryable?: boolean;
}>;

const brokenMessages = {
  SEMANTIC_QUERY_INVALID: {
    title: "Consulta do widget inválida",
    description: "Este widget precisa ser revisado.",
  },
  VISUALIZATION_SPEC_INVALID: {
    title: "Visualização inválida",
    description: "Este widget precisa ser revisado.",
  },
  LAYOUT_INVALID: {
    title: "Posicionamento inválido",
    description: "O widget não possui um layout utilizável.",
  },
  WORKSPACE_RELATION_INVALID: {
    title: "Fonte indisponível neste workspace",
    description: "Este widget precisa ser revisado.",
  },
  VISUALIZATION_INCOMPATIBLE: {
    title: "Visualização incompatível",
    description: "Os resultados não são compatíveis com esta visualização.",
  },
} as const satisfies Record<string, Message>;

function errorMessage(
  result: Extract<ExecuteDashboardWidgetResult, { status: "ERROR" }>,
): Message {
  if (result.reason === "DATA_NOT_READY")
    return result.dataStatus === "PROCESSING"
      ? {
          title: "Dados em processamento",
          description: "Aguarde o processamento e atualize o Dashboard.",
          retryable: true,
        }
      : {
          title: "Dados não puderam ser preparados",
          description: "O dataset precisa ser revisado.",
        };

  return {
    MODEL_NOT_PUBLISHED: {
      title: "Modelo ainda não publicado",
      description: "O modelo precisa ser publicado antes do consumo.",
    },
    QUERY_NOT_SUPPORTED: {
      title: "Consulta ainda não suportada",
      description: "A configuração do widget precisa ser revisada.",
    },
    SOURCE_UNAVAILABLE: {
      title: "Dados temporariamente indisponíveis",
      description: "Tente atualizar o Dashboard.",
      retryable: true,
    },
    SOURCE_INCONSISTENT: {
      title: "Fonte de dados inconsistente",
      description: "O dataset precisa ser revisado.",
    },
    QUERY_EXECUTION_FAILED: {
      title: "Não foi possível calcular este widget",
      description: "Tente atualizar o Dashboard.",
      retryable: true,
    },
    QUERY_TIMEOUT: {
      title: "O cálculo demorou além do limite",
      description: "Tente atualizar o Dashboard.",
      retryable: true,
    },
    RESULT_LIMIT_EXCEEDED: {
      title: "Resultado amplo demais",
      description: "A consulta precisa ser reduzida.",
    },
    RESULT_TOO_LARGE: {
      title: "Resultado grande demais",
      description: "A consulta precisa ser reduzida.",
    },
    INCONSISTENT_WIDGET_METADATA: {
      title: "Widget inconsistente",
      description: "Este widget precisa ser revisado.",
    },
    INCONSISTENT_QUERY_PIPELINE: {
      title: "Não foi possível validar o resultado",
      description: "Este widget precisa ser revisado.",
    },
    OPERATIONAL_FAILURE: {
      title: "Serviço temporariamente indisponível",
      description: "Tente atualizar o Dashboard.",
      retryable: true,
    },
  }[result.reason];
}

export function widgetContext(viewModel: VisualizationViewModel): {
  title: string;
  subtitle?: string;
} {
  if (viewModel.type === "KPI") return { title: viewModel.metric.label };
  if (viewModel.type === "BAR")
    return {
      title: `${viewModel.value.label} por ${viewModel.category.label}`,
    };
  if (viewModel.type === "LINE")
    return { title: `${viewModel.y.label} por ${viewModel.x.label}` };
  return {
    title: "Tabela de dados",
    subtitle: viewModel.columns.map((column) => column.label).join(", "),
  };
}

function State({
  message,
  tone,
}: {
  message: Message;
  tone: "attention" | "error" | "neutral";
}) {
  return (
    <div className={`${styles.state} ${styles[tone]}`}>
      <h2>{message.title}</h2>
      <p>{message.description}</p>
    </div>
  );
}

function WidgetContent({ result }: { result: ExecuteDashboardWidgetResult }) {
  if (result.status === "SUCCESS" || result.status === "EMPTY") {
    const context = widgetContext(result.viewModel);
    return (
      <>
        <header className={styles.widgetHeader}>
          <div>
            <h2>{context.title}</h2>
            {context.subtitle && <p>{context.subtitle}</p>}
          </div>
          <ExplanationDrawer explanation={result.explanation} />
        </header>
        {result.status === "EMPTY" && (
          <p className={styles.empty} role="status">
            Nenhum dado corresponde a esta configuração.
          </p>
        )}
        <div className={styles.visualization}>
          <VisualizationRenderer viewModel={result.viewModel} />
        </div>
      </>
    );
  }
  if (result.status === "BROKEN")
    return <State message={brokenMessages[result.reason]} tone="attention" />;
  if (result.status === "ERROR")
    return <State message={errorMessage(result)} tone="error" />;
  if (result.status === "NOT_FOUND")
    return (
      <State
        message={{
          title: "Widget indisponível",
          description: "Este widget não está mais disponível.",
        }}
        tone="neutral"
      />
    );
  return (
    <State
      message={{
        title: "Execução interrompida",
        description: "Atualize o Dashboard para tentar novamente.",
      }}
      tone="neutral"
    />
  );
}

function WidgetCard({
  item,
  positioned,
}: {
  item: DashboardExecutionItem;
  positioned: boolean;
}) {
  const style = item.layout
    ? ({
        gridColumn: `${item.layout.x + 1} / span ${item.layout.width}`,
        gridRow: `${item.layout.y + 1} / span ${item.layout.height}`,
        "--tablet-span": Math.min(6, Math.ceil(item.layout.width / 2)),
      } satisfies WidgetStyle)
    : undefined;
  return (
    <article className={styles.widget} style={positioned ? style : undefined}>
      <WidgetContent result={item.result} />
    </article>
  );
}

export function DashboardView({
  name,
  description,
  execution,
}: Readonly<{
  name: string;
  description: string | null;
  execution: CompletedDashboard;
}>) {
  const positioned = execution.widgets.filter((item) => item.layout !== null);
  const unpositioned = execution.widgets.filter((item) => item.layout === null);

  return (
    <>
      <nav className={styles.breadcrumb} aria-label="Breadcrumb">
        <span>Início</span>
        <span aria-hidden="true">/</span>
        <span>Dashboard</span>
      </nav>
      <header className={styles.dashboardHeader}>
        <div>
          <h1>{name}</h1>
          {description && <p>{description}</p>}
        </div>
        <RefreshButton />
      </header>

      {execution.status === "CANCELLED" && (
        <p className={styles.banner} role="status">
          A atualização foi interrompida. Os resultados concluídos foram
          preservados.
        </p>
      )}

      {execution.widgets.length === 0 ? (
        <section className={styles.pageState} aria-labelledby="empty-dashboard">
          <h2 id="empty-dashboard">Dashboard vazio</h2>
          <p>Este Dashboard ainda não possui widgets.</p>
        </section>
      ) : (
        <>
          {positioned.length > 0 && (
            <section className={styles.grid} aria-label="Widgets do Dashboard">
              {positioned.map((item) => (
                <WidgetCard key={item.widgetId} item={item} positioned />
              ))}
            </section>
          )}
          {unpositioned.length > 0 && (
            <section
              className={styles.attentionArea}
              aria-labelledby="attention-title"
            >
              <h2 id="attention-title">Widgets que precisam de atenção</h2>
              <div className={styles.attentionList}>
                {unpositioned.map((item) => (
                  <WidgetCard
                    key={item.widgetId}
                    item={item}
                    positioned={false}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}

export function DashboardFailure({
  inconsistent = false,
}: {
  inconsistent?: boolean;
}) {
  return (
    <section className={styles.pageState} role="alert">
      <h1>Dashboard temporariamente indisponível</h1>
      <p>
        {inconsistent
          ? "Não foi possível carregar este Dashboard com segurança."
          : "Não foi possível carregar o Dashboard agora."}
      </p>
      <RefreshButton />
    </section>
  );
}
