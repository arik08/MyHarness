import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AsideWorkflowTimeline, asideCallTitle } from "../AsideWorkflowTimeline";
import type { WorkflowEvent } from "../../types/ui";

afterEach(cleanup);

const event = (path: string, toolName = "edit_file"): WorkflowEvent => ({
  id: "relative-path", toolName, title: "", detail: "", status: "done", toolInput: { file_path: path },
});

it.each([
  ["C:\\work\\project\\src\\hooks\\file.ts", "c:/work/project/", "src/hooks/file.ts"],
  ["/work/project/src/file.ts", "/work/project", "src/file.ts"],
  ["src/file.ts", "/work/project", "src/file.ts"],
  ["/work/project-other/file.ts", "/work/project", "../project-other/file.ts"],
  ["D:/other/file.ts", "C:/work/project", "file.ts"],
  ["/work/project/file.ts", "", "file.ts"],
  ["\\\\server\\share\\project\\file.ts", "\\\\server\\share\\project", "file.ts"],
  ["\\\\?\\C:\\work\\project\\src\\file.ts", "C:/work/project", "src/file.ts"],
  ["/file.ts", "/", "file.ts"],
])("shows a relative header for %s", (path, root, expected) => {
  expect(asideCallTitle(event(path), root)).toBe(`파일 수정 · ${expected}`);
});

it.each(["read_file", "write_file", "edit_file", "future_file_tool"])("renders a counted summary and shortened accessible title for %s", (toolName) => {
  render(<AsideWorkflowTimeline events={[event("C:/work/project/src/new.ts", toolName)]}
    workspacePath="C:/work/project" scope={`relative-${toolName}`} duration={1} busy={false} />);
  expect(document.querySelector(".aside-call-title")?.textContent).toContain("(1건)");
  expect(screen.getByRole("button", { name: /src\/new.ts 상세 실행 기록/ }).textContent).not.toContain("C:/");
});

it("preserves URLs and the original tool input", () => {
  const original = event("C:/work/project/src/new.ts");
  asideCallTitle(original, "C:/work/project");
  expect(original.toolInput?.file_path).toBe("C:/work/project/src/new.ts");
  expect(asideCallTitle({ ...original, toolName: "web_fetch", toolInput: { url: "https://example.com/a" } })).toContain("https://example.com/a");
});
