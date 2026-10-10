import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { isNavigationActive } from "../../src/components/layout/primary-navigation.tsx";
import { PageHeader } from "../../src/components/ui/page-header.tsx";
import { StatusBadge } from "../../src/components/ui/status-badge.tsx";

describe("application shell primitives", () => {
  test("marks only the matching primary destination as active", () => {
    expect(isNavigationActive("/", "/")).toBe(true);
    expect(isNavigationActive("/data", "/data")).toBe(true);
    expect(isNavigationActive("/data/upload", "/data")).toBe(true);
    expect(isNavigationActive("/dashboards", "/dashboards")).toBe(true);
    expect(isNavigationActive("/dashboards/id", "/dashboards")).toBe(true);
    for (const pathname of ["/", "/data", "/dashboards/id"]) {
      const active = (["/", "/data", "/dashboards"] as const).filter((href) =>
        isNavigationActive(pathname, href),
      );
      expect(active).toHaveLength(1);
    }
  });

  test("renders a single page heading with breadcrumb and status", () => {
    const html = renderToStaticMarkup(
      createElement(PageHeader, {
        title: "Dataset",
        breadcrumbs: [{ label: "Dados", href: "/data" }, { label: "Dataset" }],
        actions: createElement(StatusBadge, { status: "READY" }),
      }),
    );
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain("Pronto");
  });

  test("owns the shell only in the root layout", () => {
    const root = readFileSync("src/app/layout.tsx", "utf8");
    expect(root.match(/<AppShell>/g)).toHaveLength(1);
    for (const file of [
      "page.tsx",
      "loading.tsx",
      "error.tsx",
      "not-found.tsx",
    ]) {
      const source = readFileSync(
        `src/app/dashboards/[dashboardId]/${file}`,
        "utf8",
      );
      expect(source).not.toContain("AppShell");
      expect(source).not.toContain("<main");
    }
  });
});
