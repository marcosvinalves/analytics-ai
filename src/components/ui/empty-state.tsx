import type { ReactNode } from "react";
import styles from "./ui.module.css";

export function EmptyState({
  title,
  description,
  action,
}: Readonly<{ title: string; description: string; action?: ReactNode }>) {
  return (
    <section className={styles.emptyState}>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </section>
  );
}
