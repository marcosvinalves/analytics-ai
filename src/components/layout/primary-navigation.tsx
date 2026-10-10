"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./app-shell.module.css";

export function isNavigationActive(
  pathname: string,
  href: "/" | "/data" | "/dashboards",
) {
  return href === "/"
    ? pathname === "/"
    : pathname === href || pathname.startsWith(`${href}/`);
}

const links = [
  { href: "/" as const, label: "Início" },
  { href: "/data" as const, label: "Dados" },
  { href: "/dashboards" as const, label: "Dashboards" },
];

export function PrimaryNavigation() {
  const pathname = usePathname();
  return (
    <nav
      className={styles.navigation}
      aria-label="Navegação principal"
      data-primary-navigation
    >
      {links.map((link) => {
        const active = isNavigationActive(pathname, link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
