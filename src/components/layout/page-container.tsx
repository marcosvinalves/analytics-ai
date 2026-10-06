import type { ReactNode } from "react";
import styles from "./app-shell.module.css";

export function PageContainer({
  children,
  wide = false,
}: Readonly<{ children: ReactNode; wide?: boolean }>) {
  return (
    <div className={`${styles.container} ${wide ? styles.wide : ""}`}>
      {children}
    </div>
  );
}
