import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import Home from "../../src/app/page";

test("a página inicial renderiza no servidor", () => {
  const html = renderToStaticMarkup(createElement(Home));

  expect(html).toContain("<h1>Analytics AI</h1>");
  expect(html).toContain("Technical Alpha");
});
