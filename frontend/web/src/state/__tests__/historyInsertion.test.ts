import { describe, expect, it } from "vitest";
import { appReducer, initialAppState } from "../reducer";

describe("new saved history insertion", () => {
  it("prepends arbitrary saved conversations without disabling older-page loading or duplicating rows", () => {
    const history = Array.from({ length: 40 }, (_, index) => ({ value: `saved-${index}`, label: `Existing ${index}` }));
    const initial = { ...initialAppState, history, historyHasMore: true, historyNextOffset: 40 };
    const item = { value: "new-saved-copy", label: "Copied conversation" };
    const inserted = appReducer(initial, { type: "prepend_history", history: [item] });
    expect(inserted.history[0]).toEqual(item);
    expect(inserted.historyHasMore).toBe(true);
    expect(inserted.historyNextOffset).toBe(41);
    const repeated = appReducer(inserted, { type: "prepend_history", history: [item] });
    expect(repeated.history).toHaveLength(41);
    expect(repeated.historyNextOffset).toBe(41);
    const nextPage = appReducer(repeated, { type: "append_history", history: [{ value: "older", label: "Older" }], hasMore: false, nextOffset: 42 });
    expect(nextPage.history[0]).toEqual(item);
    expect(nextPage.history.at(-1)?.value).toBe("older");
    expect(initial.history).toEqual(history);
  });
});
