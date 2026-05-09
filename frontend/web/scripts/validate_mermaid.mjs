import mermaid from "mermaid";

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "loose",
});

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}

const payload = JSON.parse(chunks.join("") || "{}");
const errors = [];

for (const diagram of payload.diagrams || []) {
  try {
    await mermaid.parse(String(diagram.source || ""), { suppressErrors: false });
  } catch (error) {
    errors.push({
      index: diagram.index,
      origin: diagram.origin,
      message: normalizeError(error),
    });
  }
}

process.stdout.write(JSON.stringify({ ok: errors.length === 0, errors }));

function normalizeError(error) {
  const message = error && typeof error.message === "string" ? error.message : String(error || "Parse error");
  return message.replace(/\s+$/g, "");
}
