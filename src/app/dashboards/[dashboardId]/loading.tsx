import { AppShell } from "@/components/layout/app-shell";
import styles from "@/components/dashboard/dashboard.module.css";

export default function LoadingDashboard() {
  return (
    <AppShell>
      <div aria-busy="true" aria-live="polite">
        <p role="status">Carregando Dashboard…</p>
        <div className={styles.loadingHeader} aria-hidden="true" />
        <div className={styles.loadingGrid} aria-hidden="true">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className={styles.loadingCard} />
          ))}
        </div>
        <span className="sr-only">
          Os placeholders não representam a quantidade real de widgets.
        </span>
      </div>
    </AppShell>
  );
}
