import type { HTMLAttributes, ReactNode } from "react";
import styles from "./ui.module.css";

export function InlineNotice({
  tone = "info",
  className = "",
  children,
  ...props
}: HTMLAttributes<HTMLElement> & {
  tone?: "info" | "success" | "attention" | "danger";
  children: ReactNode;
}) {
  return (
    <section
      className={`${styles.notice} ${styles[tone]} ${className}`}
      {...props}
    >
      {children}
    </section>
  );
}
