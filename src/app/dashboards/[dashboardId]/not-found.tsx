import Link from "next/link";
import { AppShell } from "@/components/layout/app-shell";
import styles from "@/components/dashboard/dashboard.module.css";

export default function DashboardNotFound() {
  return (
    <AppShell>
      <section className={styles.pageState}>
        <h1>Dashboard não encontrado</h1>
        <p>O Dashboard solicitado não está disponível.</p>
        <Link href="/">Voltar ao início</Link>
      </section>
    </AppShell>
  );
}
