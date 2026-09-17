import { useEffect, useRef, useState } from "react";

// Lock synchronously, before React renders, so rapid clicks cannot duplicate work.
export function useAsyncAction(scope?: unknown) {
  const inFlight = useRef(false);
  const generation = useRef(0);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    inFlight.current = false;
    setPending(false);
    return () => { generation.current += 1; };
  }, [scope]);
  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    const startedGeneration = generation.current;
    inFlight.current = true;
    setPending(true);
    try {
      await action();
    } finally {
      if (startedGeneration === generation.current) {
        inFlight.current = false;
        setPending(false);
      }
    }
  }
  return { pending, run };
}
