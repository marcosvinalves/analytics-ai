import Link from "next/link";
import type { ReactNode } from "react";
import { PrimaryNavigation } from "./primary-navigation";
import styles from "./app-shell.module.css";

export function AppShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className={styles.shell} data-app-shell>
      <header className={styles.topbar}>
        <Link className={styles.brand} href="/">
          Analytics AI
        </Link>
        <span className={styles.alpha}>Technical Alpha</span>
      </header>
      <PrimaryNavigation />
      <main className={styles.content}>{children}</main>
    </div>
  );
}
