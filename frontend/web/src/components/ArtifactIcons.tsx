export type IconName = "source" | "preview" | "copy" | "fullscreen" | "restore" | "close" | "back" | "download" | "save" | "trash" | "warning" | "refresh" | "edit" | "comment" | "ai" | "undo" | "rename" | "star" | "chevron-up" | "chevron-down" | "keyboard" | "sparkles" | "network" | "plug" | "terminal";

export function Icon({ name }: { name: IconName }) {
  if (name === "source") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="m16 18 6-6-6-6" />
        <path d="m8 6-6 6 6 6" />
      </svg>
    );
  }
  if (name === "preview") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    );
  }
  if (name === "copy") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
    );
  }
  if (name === "fullscreen") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M8 3H5a2 2 0 0 0-2 2v3" />
        <path d="M16 3h3a2 2 0 0 1 2 2v3" />
        <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
        <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
      </svg>
    );
  }
  if (name === "restore") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M8 3v3a2 2 0 0 1-2 2H3" />
        <path d="M16 3v3a2 2 0 0 0 2 2h3" />
        <path d="M8 21v-3a2 2 0 0 0-2-2H3" />
        <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
      </svg>
    );
  }
  if (name === "back") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="m15 18-6-6 6-6" />
      </svg>
    );
  }
  if (name === "download") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M12 3v11" />
        <path d="m7 10 5 5 5-5" />
        <path d="M5 20h14" />
      </svg>
    );
  }
  if (name === "save") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
        <path d="M17 21v-8H7v8" />
        <path d="M7 3v5h8" />
      </svg>
    );
  }
  if (name === "trash") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M3 6h18" />
        <path d="M8 6V4h8v2" />
        <path d="M19 6l-1 14H6L5 6" />
        <path d="M10 11v5" />
        <path d="M14 11v5" />
      </svg>
    );
  }
  if (name === "warning") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M12 3 21 20H3L12 3Z" />
        <path d="M12 9v5" />
        <path d="M12 17h.01" />
      </svg>
    );
  }
  if (name === "refresh") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M21 12a9 9 0 0 1-15.4 6.4L3 16" />
        <path d="M3 12a9 9 0 0 1 15.4-6.4L21 8" />
        <path d="M3 21v-5h5" />
        <path d="M21 3v5h-5" />
      </svg>
    );
  }
  if (name === "edit") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
    );
  }
  if (name === "comment") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-6a8 8 0 1 1 18-5Z" />
        <path d="M8 11h8" />
        <path d="M8 15h5" />
      </svg>
    );
  }
  if (name === "ai") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M15 4V2" />
        <path d="M15 10V8" />
        <path d="M12 5h6" />
        <path d="m4 20 10.5-10.5" />
        <path d="m13 11 2 2" />
        <path d="M5 5l1 2 2 1-2 1-1 2-1-2-2-1 2-1Z" />
      </svg>
    );
  }
  if (name === "undo") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M9 7 4 12l5 5" />
        <path d="M4 12h10a6 6 0 0 1 0 12h-1" />
      </svg>
    );
  }
  if (name === "rename") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M4 7h7" />
        <path d="M4 17h7" />
        <path d="M15 4v16" />
        <path d="M12 4h6" />
        <path d="M12 20h6" />
      </svg>
    );
  }
  if (name === "star") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M12 3.7l2.5 5.05 5.58.82-4.04 3.93.95 5.55L12 16.43l-4.99 2.62.95-5.55-4.04-3.93 5.58-.82Z" />
      </svg>
    );
  }
  if (name === "chevron-up") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="m18 15-6-6-6 6" />
      </svg>
    );
  }
  if (name === "chevron-down") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="m6 9 6 6 6-6" />
      </svg>
    );
  }
  if (name === "keyboard") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M7 9h.01" />
        <path d="M11 9h.01" />
        <path d="M15 9h.01" />
        <path d="M7 13h.01" />
        <path d="M11 13h6" />
      </svg>
    );
  }
  if (name === "sparkles") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M12 3l1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4Z" />
        <path d="M5 15l.7 2.1L8 18l-2.3.9L5 21l-.7-2.1L2 18l2.3-.9Z" />
        <path d="M18 13l.8 2.2L21 16l-2.2.8L18 19l-.8-2.2L15 16l2.2-.8Z" />
      </svg>
    );
  }
  if (name === "network") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <circle cx="12" cy="5" r="2.5" />
        <circle cx="6" cy="18" r="2.5" />
        <circle cx="18" cy="18" r="2.5" />
        <path d="m11 7.3-4 8.4" />
        <path d="m13 7.3 4 8.4" />
        <path d="M8.5 18h7" />
      </svg>
    );
  }
  if (name === "plug") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M9 2v6" />
        <path d="M15 2v6" />
        <path d="M7 8h10v4a5 5 0 0 1-10 0Z" />
        <path d="M12 17v5" />
      </svg>
    );
  }
  if (name === "terminal") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="m4 7 6 5-6 5" />
        <path d="M12 19h8" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
