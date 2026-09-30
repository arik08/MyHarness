/** Incremental top-level JSON string fields used only for a streamed preview. */
export type StreamedJsonInput = {
  fields: Record<string, string>;
  editLines: Record<string, string>;
  depth: number;
  phase: "key" | "colon" | "value" | "after";
  stringKind: "key" | "value" | "skip" | null;
  key: string;
  pending: string;
  complete: boolean;
};

function decode(fragment: string) {
  try {
    return JSON.parse(`"${fragment}"`) as string;
  } catch {
    // Tool arguments may temporarily be malformed; retain best-effort output.
    return fragment.replace(/\\(u([0-9a-fA-F]{4})|[\s\S])/g, (_match, escaped: string, hex?: string) => {
      if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
      return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[escaped] ?? escaped;
    });
  }
}

export function appendStreamedJsonInput(previous: StreamedJsonInput | undefined, delta: string): StreamedJsonInput {
  const initial: StreamedJsonInput = {
    fields: Object.create(null), editLines: {}, depth: 0, phase: "key", stringKind: null, key: "", pending: "", complete: false,
  };
  const state = previous && !(previous.complete && /^\s*\{/.test(delta))
    ? { ...previous, fields: Object.assign(Object.create(null), previous.fields), editLines: { ...previous.editLines } } : initial;
  const source = state.pending + delta;
  state.pending = "";
  let cursor = 0;
  const append = (fragment: string) => {
    if (!fragment || state.stringKind === "skip") return;
    const value = decode(fragment);
    if (state.stringKind === "key") state.key += value;
    else {
      state.fields[state.key] = (state.fields[state.key] || "") + value;
      const prefix = state.key === "old_str" || state.key === "old_string" ? "--"
        : state.key === "new_str" || state.key === "new_string" ? "++" : "";
      if (prefix) {
        let lines = state.editLines[state.key] || `${prefix} `;
        if (lines.endsWith("\r") && value.startsWith("\n")) lines = lines.slice(0, -1);
        state.editLines[state.key] = lines + value.replace(/\r\n/g, "\n").replace(/\n/g, `\n${prefix} `);
      }
    }
  };
  const special = /["\\]/g;
  while (cursor < source.length) {
    if (state.stringKind) {
      const start = cursor;
      let end = source.length;
      let closed = false;
      special.lastIndex = cursor;
      let match: RegExpExecArray | null;
      while ((match = special.exec(source))) {
        cursor = match.index;
        if (match[0] === '"') {
          end = cursor;
          closed = true;
          break;
        }
        const suffix = source.slice(cursor, cursor + 6);
        if (cursor + 1 === source.length || /^\\u[0-9a-fA-F]{0,3}$/.test(suffix)) {
          end = cursor;
          state.pending = source.slice(cursor);
          break;
        }
        special.lastIndex = cursor + 2;
      }
      append(source.slice(start, end));
      if (!closed) break;
      state.phase = state.stringKind === "key" ? "colon" : state.depth === 1 ? "after" : state.phase;
      state.stringKind = null;
      cursor = end + 1;
      continue;
    }
    const char = source[cursor++];
    if (char === '"') {
      if (state.depth === 1 && state.phase === "key") {
        state.key = "";
        state.stringKind = "key";
      } else if (state.depth === 1 && state.phase === "value") {
        state.fields[state.key] = "";
        delete state.editLines[state.key];
        state.stringKind = "value";
      } else state.stringKind = "skip";
    } else if (char === "{" || char === "[") {
      state.depth += 1;
      state.complete = false;
    } else if (char === "}" || char === "]") {
      state.depth = Math.max(0, state.depth - 1);
      if (!state.depth) state.complete = true;
    } else if (state.depth === 1 && char === ":") state.phase = "value";
    else if (state.depth === 1 && char === ",") state.phase = "key";
  }
  return state;
}
