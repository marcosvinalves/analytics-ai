import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./ui.module.css";

type Variant = "primary" | "secondary" | "ghost";
const classes = (variant: Variant) => `${styles.action} ${styles[variant]}`;

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button className={`${classes(variant)} ${className}`} {...props} />;
}

export function ActionLink({
  href,
  children,
  variant = "secondary",
}: Readonly<{ href: string; children: ReactNode; variant?: Variant }>) {
  return (
    <Link className={classes(variant)} href={href}>
      {children}
    </Link>
  );
}
