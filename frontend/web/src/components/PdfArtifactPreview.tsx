import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import "./PdfArtifactPreview.css";

export function PdfArtifactPreview({ src, name, downloadUrl }: { src: string; name: string; downloadUrl: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(640);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(1, element.clientWidth - 24));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    let task: import("pdfjs-dist").PDFDocumentLoadingTask | undefined;
    setDocument(null);
    setPage(1);
    setError("");
    setLoading(true);
    void import("pdfjs-dist").then((pdfjs) => {
      if (disposed) return;
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;
      task = pdfjs.getDocument({
        url: src,
        cMapUrl: "/vendor/pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
        wasmUrl: "/vendor/pdfjs/wasm/",
      });
      return task.promise.then((pdf) => {
        if (!disposed) setDocument(pdf);
      });
    }).catch(() => {
      if (!disposed) {
        setError("PDF를 열지 못했습니다. 파일이 손상되었거나 암호로 보호되어 있는지 확인해 주세요.");
        setLoading(false);
      }
    });
    return () => { disposed = true; void task?.destroy(); };
  }, [src]);

  useEffect(() => {
    if (!document || !host.current) return;
    let disposed = false;
    let renderTask: RenderTask | undefined;
    const canvas = window.document.createElement("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `${name} ${page}페이지`);
    const container = host.current;
    setLoading(true);
    setError("");
    void document.getPage(page).then(async (pdfPage) => {
      if (disposed) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const scale = Math.min(width / base.width, 2);
      const viewport = pdfPage.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.ceil(viewport.width * ratio);
      canvas.height = Math.ceil(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      renderTask = pdfPage.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await renderTask.promise;
      if (!disposed) {
        container.append(canvas);
        setLoading(false);
      }
    }).catch(() => {
      if (!disposed) {
        setError("이 페이지를 표시하지 못했습니다. 원본 파일을 다운로드해 확인해 주세요.");
        setLoading(false);
      }
    });
    return () => { disposed = true; renderTask?.cancel(); canvas.remove(); };
  }, [document, page, width, name]);

  return (
    <section className="artifact-pdf-preview" aria-label={`${name} PDF 미리보기`}>
      <div className="artifact-pdf-toolbar">
        <button type="button" aria-label="이전 페이지" disabled={!document || page <= 1} onClick={() => setPage(page - 1)}>이전</button>
        <span aria-live="polite">{document ? `${page} / ${document.numPages}` : "PDF"}</span>
        <button type="button" aria-label="다음 페이지" disabled={!document || page >= document.numPages} onClick={() => setPage(page + 1)}>다음</button>
        <a href={downloadUrl} download={name}>다운로드</a>
      </div>
      {loading && <p role="status">PDF를 불러오는 중입니다…</p>}
      {error && <p role="alert">{error}</p>}
      <div className="artifact-pdf-pages" ref={host} aria-busy={loading} />
    </section>
  );
}
