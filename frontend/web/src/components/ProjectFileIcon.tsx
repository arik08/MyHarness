/** Compact file silhouettes; format details stay available in the custom tooltip. */
export function ProjectFileIcon({ label, tone }: { label: string; tone: string }) {
  const glyph = (() => {
    switch (tone) {
      case "web":
        return <><rect x="4" y="5" width="24" height="23" rx="3" /><path d="M4 11h24M8 8h.01M11 8h.01m1 8-3 3 3 3m8-6 3 3-3 3m-3-7-2 8" /></>;
      case "data":
        return <><path d="M12 13h-1a2 2 0 0 0-2 2v2l-2 2 2 2v2a2 2 0 0 0 2 2h1m8-12h1a2 2 0 0 1 2 2v2l2 2-2 2v2a2 2 0 0 1-2 2h-1" /><circle cx="16" cy="17" r=".75" fill="currentColor" stroke="none" /><circle cx="16" cy="22" r=".75" fill="currentColor" stroke="none" /></>;
      case "code":
        return <path d="m12 15-4 4 4 4m8-8 4 4-4 4m-3-10-2 12" />;
      case "markdown":
        return <path d="M8 24v-9l4 5 4-5v9m6-9v9m-3-3 3 3 3-3" />;
      case "image":
        return <><circle cx="12" cy="15" r="2" /><path d="m6 25 7-6 4 4 3-3 6 5" /></>;
      case "archive":
        return <path d="M14 11h3m-3 3h3m-3 3h3m-3 3h3m-3 3h3v3h-3z" />;
      default:
        return <path d="M10 15h10M10 19h12M10 23h8" />;
    }
  })();

  return (
    <span className={`artifact-card-icon artifact-card-icon-${tone} project-file-icon`} data-tooltip={label} role="img" aria-label={`${label} 파일`}>
      <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {tone !== "web" && <><path className="project-file-icon-sheet" d="M19 3H8a3 3 0 0 0-3 3v22a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V11Z" /><path d="M19 3v6a2 2 0 0 0 2 2h6" /></>}
        {glyph}
      </svg>
    </span>
  );
}
