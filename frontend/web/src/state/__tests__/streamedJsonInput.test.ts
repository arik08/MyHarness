import { expect, it } from "vitest";
import { appendStreamedJsonInput, type StreamedJsonInput } from "../streamedJsonInput";

it.each([1, 2, 7, 101])("decodes generic fields without confusing nested or quoted keys (%i)", (size) => {
  const source = JSON.stringify({ path: '"content": "fake"', nested: { content: "nested" },
    enabled: true, array: ["skip", 123], content: '한글 😀\\\n\t"끝"',
    old_str: "first\r\nsecond\n", new_string: "\r\nnew\r", __proto__: null });
  let state: StreamedJsonInput | undefined;
  for (let i = 0; i < source.length; i += size) state = appendStreamedJsonInput(state, source.slice(i, i + size));
  expect(state?.fields).toEqual({ path: '"content": "fake"', content: '한글 😀\\\n\t"끝"', old_str: "first\r\nsecond\n", new_string: "\r\nnew\r" });
  expect(state?.editLines.old_str).toBe("-- first\n-- second\n-- ");
  expect(state?.editLines.new_string).toBe("++ \n++ new\r");
  expect(state?.complete).toBe(true);
});

it("preserves immutable branches and resets a completed tool input", () => {
  const first = appendStreamedJsonInput(undefined, '{"content":"before\\uD');
  const left = appendStreamedJsonInput(first, '55C"}');
  const right = appendStreamedJsonInput(first, '55D"}');
  expect(first.fields.content).toBe("before");
  expect(left.fields.content).toBe("before한");
  expect(right.fields.content).toBe("before핝");
  expect(appendStreamedJsonInput(left, '{"path":"next.txt","content":"next"}').fields).toEqual({ path: "next.txt", content: "next" });
});

it.each([1, 2, 100])("handles arbitrary field names without modifying the field object's prototype (%i)", (size) => {
  const source = '{"__proto__":"safe","constructor":"also safe"}';
  let parsed: StreamedJsonInput | undefined;
  for (let i = 0; i < source.length; i += size) parsed = appendStreamedJsonInput(parsed, source.slice(i, i + size));
  expect(Object.hasOwn(parsed!.fields, "__proto__")).toBe(true);
  expect(parsed?.fields.__proto__).toBe("safe");
  expect(parsed?.fields.constructor).toBe("also safe");
});
