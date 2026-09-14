import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { MarkdownMessage } from "../MarkdownMessage";

afterEach(cleanup);

it.each([
  "1. 제목\n   - 첫 문장\n   - 마지막 문장\n\n[출처: 신규](https://new.example/doc)",
  "1. 제목\n\n   - 첫 문장\n\n   - 마지막 문장\n\n[출처: 신규](https://new.example/doc)",
  "> 첫 문장\n>\n> 마지막 문장\n\n[출처: 신규](https://new.example/doc)",
])("attaches a detached citation to the final text block: %s", (text) => {
  const { container } = render(<MarkdownMessage text={text} />);
  const chip = container.querySelector(".markdown-inline-source-chip")!;
  expect(chip.parentElement?.textContent?.trim()).toBe("마지막 문장1");
  expect(chip.parentElement?.querySelector("p, ul, ol")).toBeNull();
  expect(chip.getAttribute("href")).toBe("https://new.example/doc");
});

it.each(["  \n", "\\\n", "<br>\n"])("removes a citation's hard break %s while preserving other breaks", (separator) => {
  const { container } = render(<MarkdownMessage text={`첫 줄  \n마지막 문장${separator}[출처: 신규](https://new.example/doc)`} />);
  expect(container.querySelectorAll("br")).toHaveLength(1);
  expect(container.querySelector(".markdown-inline-source-chip")?.previousSibling?.textContent).toContain("마지막 문장");
});

it("attaches a streaming tail inside the last nested paragraph", () => {
  const { container } = render(<MarkdownMessage text={"1. 제목\n\n   - 첫 문장\n\n   - 마지막 문장"} inlineTailHtml={'<a class="markdown-inline-source-chip" href="https://new.example/doc">1</a>'} />);
  expect(container.querySelector(".markdown-inline-source-chip")?.parentElement?.textContent).toBe("마지막 문장1");
});
