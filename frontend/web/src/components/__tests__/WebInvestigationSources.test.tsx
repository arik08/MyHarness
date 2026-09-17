import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { WebInvestigationSources } from "../WorkflowPanel";

afterEach(cleanup);

it("keeps sources mounted after favicon failures and subsequent updates", () => {
  const sources = Array.from({ length: 56 }, (_, index) => ({
    url: `https://source-${index}.example/report`, label: `Source ${index}`,
    domain: `source-${index}.example`, path: "/report",
  }));
  const queries = Array.from({ length: 8 }, (_, index) => `query ${index}`);
  const view = render(<WebInvestigationSources sources={sources} queries={queries} />);
  fireEvent.click(view.container.querySelector("summary")!);
  for (const img of view.container.querySelectorAll("img")) fireEvent.error(img);
  expect(() => view.rerender(<WebInvestigationSources sources={[...sources]} queries={[...queries, "new query"]} />)).not.toThrow();
  expect(view.container.querySelectorAll("li")).toHaveLength(56);
  expect(view.container.querySelectorAll("img")).toHaveLength(0);
  expect(view.container.querySelector("details")?.open).toBe(true);
  fireEvent.pointerDown(document.body);
  expect(view.container.querySelector("details")?.open).toBe(false);
  fireEvent.click(view.container.querySelector("summary")!);
  expect(view.container.querySelector("details")?.open).toBe(true);
  expect(() => view.unmount()).not.toThrow();
});

it("preserves healthy icons and handles shared origins and invalid URLs", () => {
  const sources = ["https://shared.example/a", "https://shared.example/b", "https://healthy.example/c", "invalid-url"].map((url) => ({ url, label: url, domain: "", path: "" }));
  const view = render(<WebInvestigationSources sources={sources} queries={[]} />);
  const images = view.container.querySelectorAll("img");
  expect(images).toHaveLength(3);
  fireEvent.error(images[0]);
  fireEvent.load(images[2]);
  view.rerender(<WebInvestigationSources sources={[...sources]} queries={["updated"]} />);
  expect(view.container.querySelectorAll("img")).toHaveLength(1);
  expect(view.container.querySelector("img")?.src).toBe("https://healthy.example/favicon.ico");
  expect(view.container.querySelectorAll("a")).toHaveLength(4);
  view.unmount();
  const restored = render(<WebInvestigationSources sources={sources} queries={[]} />);
  expect(restored.container.querySelectorAll("img")).toHaveLength(1);
});
