import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfArtifactPreview } from "../PdfArtifactPreview";

const mocks = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock("pdfjs-dist", () => ({ getDocument: mocks.getDocument, GlobalWorkerOptions: {} }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function pdfTask() {
  const cancel = vi.fn();
  const getPage = vi.fn(async () => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel })),
  }));
  const destroy = vi.fn();
  return { promise: Promise.resolve({ numPages: 2, getPage }), destroy, getPage, cancel };
}

describe("PDF preview", () => {
  it("renders pages without a native PDF viewer, navigates, and destroys the old document", async () => {
    const first = pdfTask();
    const second = pdfTask();
    mocks.getDocument.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const view = render(<PdfArtifactPreview src="/first.pdf" name="문서.pdf" downloadUrl="/download" />);
    await screen.findByRole("img", { name: "문서.pdf 1페이지" });
    expect(document.querySelector("iframe")).toBeNull();
    expect((screen.getByRole("button", { name: "이전 페이지" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    await screen.findByRole("img", { name: "문서.pdf 2페이지" });
    expect(screen.queryByRole("img", { name: "문서.pdf 1페이지" })).toBeNull();
    expect((screen.getByRole("button", { name: "다음 페이지" }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<PdfArtifactPreview src="/second.pdf" name="다음.pdf" downloadUrl="/download" />);
    await screen.findByRole("img", { name: "다음.pdf 1페이지" });
    expect(first.destroy).toHaveBeenCalledOnce();
    view.unmount();
    expect(second.destroy).toHaveBeenCalledOnce();
  });

  it("shows an error and keeps the download available when loading fails", async () => {
    mocks.getDocument.mockImplementation(() => ({ promise: Promise.reject(new Error("Invalid PDF")), destroy: vi.fn() }));
    render(<PdfArtifactPreview src="/broken.pdf" name="문서.pdf" downloadUrl="/download" />);
    expect((await screen.findByRole("alert")).textContent).toContain("PDF를 열지 못했습니다");
    expect(screen.getByRole("link", { name: "다운로드" }).getAttribute("href")).toBe("/download");
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });
});
