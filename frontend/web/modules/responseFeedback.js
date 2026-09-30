import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export async function saveResponseFeedback(directory, body, sessionId) {
  if (body.rating !== "up" && body.rating !== "down") throw new Error("평가를 선택해 주세요.");
  if (typeof body.comment !== "string" || body.comment.length > 4000) throw new Error("의견은 4,000자 이내로 입력해 주세요.");
  if (typeof body.answerText !== "string" || !body.answerText.trim() || body.answerText.length > 2_000_000) throw new Error("평가할 응답을 확인해 주세요.");
  if (!Number.isInteger(body.answerIndex) || body.answerIndex < 0) throw new Error("평가할 응답을 찾을 수 없습니다.");
  const id = randomUUID();
  const feedback = {
    id, sessionId, answerIndex: body.answerIndex,
    answerText: body.answerText, rating: body.rating, comment: body.comment.trim(),
    createdAt: new Date().toISOString(),
  };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${id}.json`), JSON.stringify(feedback, null, 2), { encoding: "utf8", flag: "wx" });
  return { id };
}
