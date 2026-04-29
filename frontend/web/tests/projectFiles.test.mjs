import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactCategoryForPath,
  isDefaultProjectFileCandidate,
  nextAvailableRelativePath,
  projectFileDirectory,
} from "../modules/projectFiles.js";

test("classifies project files into UI filter categories", () => {
  assert.equal(artifactCategoryForPath("outputs/dashboard.html"), "web");
  assert.equal(artifactCategoryForPath("outputs/summary.md"), "docs");
  assert.equal(artifactCategoryForPath("outputs/report.pptx"), "docs");
  assert.equal(artifactCategoryForPath("outputs/data.csv"), "data");
  assert.equal(artifactCategoryForPath("outputs/app.tsx"), "code");
  assert.equal(artifactCategoryForPath("outputs/photo.png"), "other");
});

test("default project file list only includes outputs and root artifact candidates", () => {
  assert.equal(isDefaultProjectFileCandidate("outputs/report.md"), true);
  assert.equal(isDefaultProjectFileCandidate("outputs/dashboard/index.html"), true);
  assert.equal(isDefaultProjectFileCandidate("report.md"), true);
  assert.equal(isDefaultProjectFileCandidate("dashboard.html"), true);
  assert.equal(isDefaultProjectFileCandidate("src/app.py"), false);
  assert.equal(isDefaultProjectFileCandidate("docs/design.md"), false);
  assert.equal(isDefaultProjectFileCandidate(".myharness/sessions/session-a.json"), false);
});

test("directories use root and outputs labels for grouped rendering", () => {
  assert.equal(projectFileDirectory("outputs/report.md"), "outputs");
  assert.equal(projectFileDirectory("outputs/dashboard/index.html"), "outputs/dashboard");
  assert.equal(projectFileDirectory("report.md"), "루트");
});

test("collision-safe paths use numeric suffixes without overwriting", () => {
  const existing = new Set(["outputs/report.md", "outputs/report-2.md"]);

  assert.equal(nextAvailableRelativePath("outputs/report.md", existing), "outputs/report-3.md");
  assert.equal(nextAvailableRelativePath("outputs/new-report.md", existing), "outputs/new-report.md");
});
