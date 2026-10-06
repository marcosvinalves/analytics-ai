import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./ui.module.css";

type Crumb = Readonly<{ label: string; href?: string }>;

export function PageHeader({
  title,
  description,
  breadcrumbs = [],
  actions,
}: Readonly<{
  title: string;
  description?: string | null;
  breadcrumbs?: readonly Crumb[];
  actions?: ReactNode;
}>) {
  return (
    <header className={styles.pageHeader}>
      <div>
        {breadcrumbs.length > 0 && (
          <nav className={styles.breadcrumbs} aria-label="Breadcrumb">
            {breadcrumbs.map((crumb, index) => (
              <span key={`${crumb.label}-${index}`}>
                {index > 0 && <span aria-hidden="true">/ </span>}
                {crumb.href ? (
                  <Link href={crumb.href}>{crumb.label}</Link>
                ) : (
                  crumb.label
                )}
              </span>
            ))}
          </nav>
        )}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </header>
  );
}
