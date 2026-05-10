import { describe, expect, it } from "vitest";
import type { ArtifactSummary } from "../../types/backend";
import {
  artifactCategory,
  artifactDisplayName,
  artifactExtension,
  artifactIcon,
  artifactKind,
  artifactKindLabel,
  artifactLabelForPath,
  artifactName,
  collectArtifactCandidates,
  collectArtifactReferences,
  dedupeArtifactsByResolvedPath,
  formatBytes,
  isKnownArtifactPath,
  isRootProjectFileCandidatePath,
  isSourceCodeArtifact,
  labelForArtifact,
  normalizeArtifactPath,
  normalizeProjectFilePath,
  sourceLanguageForArtifact,
} from "../artifacts";

describe("artifact utilities", () => {
  it("derives display-safe names from paths", () => {
    expect(normalizeArtifactPath("`outputs\\report.html`,")).toBe("outputs/report.html");
    expect(normalizeProjectFilePath("\\outputs\\report.html")).toBe("outputs/report.html");
    expect(artifactName("outputs/report.html")).toBe("report.html");
    expect(artifactName("outputs\\report.html")).toBe("report.html");
    expect(artifactName("")).toBe("artifact");
    expect(artifactDisplayName({ path: "outputs/report.html" })).toBe("report.html");
    expect(artifactDisplayName({ path: "outputs/report.html", name: "custom.html" })).toBe("custom.html");
    expect(artifactExtension("outputs/report.HTML")).toBe("html");
  });

  it("classifies nameless artifact summaries from their path", () => {
    const htmlArtifact = { path: "outputs/report.html", kind: "file" } satisfies ArtifactSummary;
    const codeArtifact = { path: "outputs/script.py", kind: "text" } satisfies ArtifactSummary;

    expect(artifactCategory(htmlArtifact)).toBe("web");
    expect(artifactCategory(codeArtifact)).toBe("code");
    expect(isSourceCodeArtifact(codeArtifact)).toBe(true);
    expect(isSourceCodeArtifact(htmlArtifact)).toBe(false);
  });

  it("derives artifact kinds, labels, icons, and source languages", () => {
    expect(isKnownArtifactPath("outputs/report.html")).toBe(true);
    expect(isKnownArtifactPath("outputs/archive.tmp")).toBe(false);
    expect(artifactKind("outputs/report.html")).toBe("html");
    expect(artifactKind("outputs/chart.png")).toBe("image");
    expect(artifactKind("outputs/manual.pdf")).toBe("pdf");
    expect(artifactKind("outputs/query.sql")).toBe("text");
    expect(artifactKind("outputs/archive.zip")).toBe("file");
    expect(artifactKindLabel("image")).toBe("이미지");
    expect(artifactLabelForPath("outputs/deck.pptx")).toBe("PPTX");
    expect(artifactIcon("markdown")).toBe("TXT");
    expect(artifactIcon("file")).toBe("FILE");
    expect(sourceLanguageForArtifact("outputs/component.tsx")).toBe("typescript");
    expect(sourceLanguageForArtifact("outputs/readme.unknown")).toBe("unknown");
  });

  it("formats sizes and detects root project file organize candidates", () => {
    expect(formatBytes()).toBe("");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(isRootProjectFileCandidatePath("report.html")).toBe(true);
    expect(isRootProjectFileCandidatePath("outputs/report.html")).toBe(false);
    expect(isRootProjectFileCandidatePath("notes.tmp")).toBe(false);
  });

  it("keeps explicit labels while tolerating nameless artifact summaries", () => {
    expect(labelForArtifact({ path: "outputs/deck.pptx", kind: "file" })).toBe("PPTX");
    expect(labelForArtifact({ path: "outputs/data.csv", kind: "file", label: "CSV" })).toBe("CSV");
  });

  it("collects artifact references from prose without duplicate paths or web URLs", () => {
    const references = collectArtifactReferences([
      '파일 경로: "outputs/report.html"',
      "참고: [deck](outputs/deck.pptx), `outputs/script.py`, https://example.com/public.pdf",
      "중복: outputs\\report.html.",
    ].join("\n"));

    expect(references.map((artifact) => artifact.path)).toEqual([
      "outputs/deck.pptx",
      "outputs/script.py",
      "outputs/report.html",
    ]);
    const report = references.find((artifact) => artifact.path === "outputs/report.html");
    expect(report?.name).toBe("report.html");
    expect(report?.label).toBe("HTML");
    expect(report?.start).toBe(0);
    expect(references.some((artifact) => artifact.path.includes("https://"))).toBe(false);

    const candidates = collectArtifactCandidates("결과물: outputs/data.csv");
    expect(candidates).toEqual([{ path: "outputs/data.csv", name: "data.csv", kind: "text", label: "텍스트" }]);
  });

  it("deduplicates artifacts by normalized path", () => {
    const artifacts = dedupeArtifactsByResolvedPath([
      { path: "outputs/report.html", kind: "html" },
      { path: "outputs\\REPORT.HTML", kind: "html" },
      { path: "", kind: "file" },
      { path: "outputs/other.html", kind: "html" },
    ]);

    expect(artifacts.map((artifact) => artifact.path)).toEqual(["outputs/report.html", "outputs/other.html"]);
  });
});
