import { useState } from "react";
import { useAppState } from "../state/app-state";
import type { TranscriptImage } from "../types/backend";
import "./user-message-images.css";

function ImageThumbnail({ image }: { image: TranscriptImage }) {
  const { state, dispatch } = useAppState();
  const [failed, setFailed] = useState(false);
  const query = new URLSearchParams({ clientId: state.clientId, path: image.path || "" });
  if (state.sessionId) query.set("session", state.sessionId);
  if (state.workspacePath) query.set("workspacePath", state.workspacePath);
  if (state.workspaceName) query.set("workspaceName", state.workspaceName);
  const src = image.path ? `/api/artifact/raw?${query}` : image.src || "";
  const label = `${image.name} 이미지 크게 보기`;
  return (
    <button
      type="button"
      className={`user-image-attachment${failed ? " image-unavailable" : ""}`}
      aria-label={failed ? `${image.name} 이미지를 불러올 수 없습니다` : label}
      data-tooltip={failed ? `${image.name} · 이미지를 불러올 수 없습니다` : label}
      disabled={failed || !src}
      onClick={() => dispatch({ type: "open_modal", modal: { kind: "imagePreview", src, name: image.name, alt: image.name } })}
    >
      {failed ? <span aria-hidden="true">!</span> : <img src={src} alt={image.name} loading="lazy" decoding="async" onError={() => setFailed(true)} />}
    </button>
  );
}

export function UserMessageImages({ images }: { images: TranscriptImage[] }) {
  return (
    <div className="user-message-images" aria-label="첨부 이미지">
      {images.map((image, index) => <ImageThumbnail key={`${image.path || image.name}-${index}`} image={image} />)}
    </div>
  );
}
