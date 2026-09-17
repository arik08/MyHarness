import { basename, isAbsolute } from "node:path";

/** Preserve explicit interpreter selection before considering cached discovery. */
export function pythonCommandCandidates({ requestedExecutable = "", requestedArgs = [], defaults, cached, resolveExecutable }) {
  const name = String(requestedExecutable || "").trim();
  const generic = ["", "python", "python.exe", "python3", "python3.exe"].includes(basename(name).toLowerCase());
  const explicit = name && (name.includes("\\") || name.includes("/") || isAbsolute(name) || !generic);
  if (explicit) {
    return [{ file: resolveExecutable(name), args: requestedArgs, label: [name, ...requestedArgs].join(" ") }];
  }
  const configured = defaults.filter((candidate) => ["MYHARNESS_PYTHON", "PYTHON"].includes(candidate.label));
  const discovered = defaults.filter((candidate) => !configured.includes(candidate));
  return [
    ...configured,
    ...(cached ? [{ ...cached, label: "cached python" }] : []),
    ...discovered,
    ...(name ? [{ file: resolveExecutable(name), args: requestedArgs, label: [name, ...requestedArgs].join(" ") }] : []),
  ];
}
