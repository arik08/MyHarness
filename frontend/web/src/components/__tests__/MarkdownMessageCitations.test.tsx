import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { MarkdownMessage } from "../MarkdownMessage";

afterEach(cleanup);

it.each(["source:mcp/new-server/record-1", "https://new.example/doc"])("preserves MCP origin for %s", (href) => {
  const { container } = render(<MarkdownMessage
    text={`설명입니다. [출처: MCP · new-server · 자료명](${href} "참고 원문입니다")`}
    sourceEvidenceByUrl={{ "https://new.example/doc": "웹 조회로도 수집된 동일 자료의 충분히 긴 설명 문장입니다." }}
  />);
  const chip = container.querySelector(".markdown-inline-source-chip")!;
  expect(chip.getAttribute("data-tooltip")).toMatch(/^MCP · new-server · 자료명\n/);
  expect(chip.getAttribute("aria-label")).toContain("MCP · new-server");
  expect(chip.hasAttribute("title")).toBe(false);
  expect(chip.textContent).toBe("1");
});

it.each(["웹검색", "웹페이지"])("keeps the %s origin distinct from MCP", (origin) => {
  const { container } = render(<MarkdownMessage text={`설명 [출처: ${origin} · 사이트](https://new.example/doc)`} />);
  expect(container.querySelector(".markdown-inline-source-chip")?.getAttribute("data-tooltip")).toBe(`${origin} · 사이트\n저장된 출처 내용이 없습니다.`);
});

it("does not guess MCP or web search origin from an unknown source", () => {
  const { container } = render(<MarkdownMessage text={'설명 [출처: 자료](source:unknown/doc "참고 원문")'} />);
  expect(container.querySelector(".markdown-inline-source-chip")?.getAttribute("data-tooltip")).toBe('자료\n"참고 원문"');
});

it("uses stored MCP content without an LLM title and opens the real record URL", () => {
  const { container } = render(<MarkdownMessage text="매출은 3억입니다. [출처: 자료](source:mcp/new-server/call/1)"
    sourceEvidenceByUrl={{ "source:mcp/new-server/call/1": { text: "매출 3억", origin: "mcp", server: "new-server", url: "https://new.example/doc" } }} />);
  const chip = container.querySelector(".markdown-inline-source-chip")!;
  expect(chip.getAttribute("data-tooltip")).toBe('MCP · new-server · 자료\n"매출 3억"');
  expect(chip.getAttribute("href")).toBe("https://new.example/doc");
});

it("keeps short factual evidence instead of discarding it", () => {
  const { container } = render(<MarkdownMessage text="금리입니다. [출처: 사이트](https://new.example/rate)"
    sourceEvidenceByUrl={{ "https://new.example/rate": { text: "기준금리 2.5%", origin: "web_search" } }} />);
  expect(container.querySelector(".markdown-inline-source-chip")?.getAttribute("data-tooltip")).toBe('웹검색 · new.example\n"기준금리 2.5%"');
});

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
