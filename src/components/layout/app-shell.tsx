import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./app-shell.module.css";

export function AppShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <Link className={styles.brand} href="/">
          Analytics AI
        </Link>
        <span className={styles.alpha}>Technical Alpha</span>
      </header>
      <nav className={styles.navigation} aria-label="Navegação principal">
        <Link href="/">Início</Link>
        <Link href="/data">Dados</Link>
      </nav>
      <main className={styles.content}>{children}</main>
    </div>
  );
}
