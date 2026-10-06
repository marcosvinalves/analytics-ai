import type { ReactNode } from "react";
import { PageContainer } from "@/components/layout/page-container";

export default function DashboardLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return <PageContainer wide>{children}</PageContainer>;
}
