import { PageHeader } from "@/components/ui/page-header";
import styles from "@/components/dashboard/dashboard.module.css";

export default function LoadingDashboard() {
  return (
    <div aria-busy="true" aria-live="polite">
      <PageHeader
        title="Carregando Dashboard…"
        breadcrumbs={[{ label: "Início", href: "/" }, { label: "Dashboard" }]}
      />
      <p className="sr-only" role="status">
        Carregando Dashboard…
      </p>
      <div className={styles.loadingGrid} aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className={styles.loadingCard} />
        ))}
      </div>
    </div>
  );
}
