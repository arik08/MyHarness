import { useEffect, useState, type ComponentProps } from "react";

type Preview = typeof import("./ArtifactPreview").ArtifactPreview;
let previewPromise: Promise<Preview> | null = null;
let loadedPreview: Preview | null = null;

function loadPreview() {
  if (!previewPromise) {
    previewPromise = import("./ArtifactPreview").then((module) => {
      loadedPreview = module.ArtifactPreview;
      return loadedPreview;
    }).catch((error: unknown) => {
      previewPromise = null;
      throw error;
    });
  }
  return previewPromise;
}

export function DeferredArtifactPreview(props: ComponentProps<Preview>) {
  const [PreviewComponent, setPreview] = useState<Preview | null>(() => loadedPreview);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    if (!PreviewComponent) {
      setFailed(false);
      void loadPreview().then((component) => {
        if (active) setPreview(() => component);
      }).catch(() => { if (active) setFailed(true); });
    }
    return () => { active = false; };
  }, [PreviewComponent]);
  if (PreviewComponent) return <PreviewComponent {...props} />;
  if (failed) return <div className="artifact-empty" role="alert">
    <p>미리보기를 불러오지 못했습니다.</p>
    <button type="button" onClick={() => window.location.reload()}>화면 새로고침</button>
  </div>;
  return <p className="artifact-empty" role="status">산출물을 불러오는 중...</p>;
}
