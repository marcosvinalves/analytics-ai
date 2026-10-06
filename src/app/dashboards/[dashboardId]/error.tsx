"use client";

import { AppShell } from "@/components/layout/app-shell";
import styles from "@/components/dashboard/dashboard.module.css";

export default function DashboardError({ reset }: { reset: () => void }) {
  return (
    <AppShell>
      <section className={styles.pageState} role="alert">
        <h1>Dashboard temporariamente indisponível</h1>
        <p>Não foi possível carregar o Dashboard agora.</p>
        <button type="button" onClick={reset}>
          Tentar novamente
        </button>
      </section>
    </AppShell>
  );
}
