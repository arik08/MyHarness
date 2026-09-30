import { readFile } from "node:fs/promises";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { writeTextFileAtomic } from "./atomicFile.js";

const derive = promisify(scrypt);
const failure = (status, message) => Object.assign(new Error(message), { status });

export async function createEntryPasswordStore(path, initialPassword) {
  let saved = { primary: null, guest: null };
  let changing = false;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    const validHash = (value) => value && /^[a-f0-9]{32}$/.test(value.salt) && /^[a-f0-9]{128}$/.test(value.hash);
    if (parsed?.version === 1 && validHash(parsed)) saved.primary = parsed;
    else if (parsed?.version === 2 && [parsed.primary, parsed.guest].every((value) => value === null || validHash(value))) saved = parsed;
    else {
      throw new Error("Invalid entry password configuration");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  async function verify(password, kind = "primary") {
    if (typeof password !== "string" || password.length > 256) return false;
    if (kind !== "primary" && kind !== "guest") return false;
    if (!saved[kind]) {
      if (kind === "guest") return false;
      return timingSafeEqual(createHash("sha256").update(password).digest(), createHash("sha256").update(initialPassword).digest());
    }
    const current = saved[kind];
    return timingSafeEqual(await derive(password, current.salt, 64), Buffer.from(current.hash, "hex"));
  }
  return {
    get enabled() { return Boolean(saved.primary || saved.guest || initialPassword); },
    cookieKey(kind = "primary") { return saved[kind]?.hash ?? (kind === "primary" ? initialPassword : null); },
    async authenticate(password) {
      if (!password) return null;
      const revision = saved;
      if (await verify(password, "primary")) return saved === revision ? "primary" : null;
      if (await verify(password, "guest")) return saved === revision ? "guest" : null;
      return null;
    },
    verify,
    async change(currentPassword, newPassword, confirmation, kind = "primary") {
      if (kind !== "primary" && kind !== "guest") throw failure(400, "비밀번호 종류가 올바르지 않습니다.");
      if (kind === "guest" && !saved.primary && !initialPassword) throw failure(400, "먼저 기본 비밀번호를 설정해 주세요.");
      if (changing) throw failure(409, "비밀번호 변경이 진행 중입니다.");
      if (typeof newPassword !== "string" || !newPassword.trim() || newPassword.length > 256) {
        throw failure(400, "새 비밀번호를 1~256자로 입력해 주세요.");
      }
      if (newPassword !== confirmation) throw failure(400, "새 비밀번호가 일치하지 않습니다.");
      changing = true;
      try {
        if (!await verify(currentPassword)) throw failure(400, "현재 기본 비밀번호가 올바르지 않습니다.");
        if (await verify(newPassword, kind)) throw failure(400, "현재 비밀번호와 다른 비밀번호를 입력해 주세요.");
        if (await verify(newPassword, kind === "primary" ? "guest" : "primary")) throw failure(400, "기본 비밀번호와 Guest 비밀번호는 서로 다르게 설정해 주세요.");
        const salt = randomBytes(16).toString("hex");
        const next = { ...saved, version: 2, [kind]: { salt, hash: (await derive(newPassword, salt, 64)).toString("hex") } };
        await writeTextFileAtomic(path, JSON.stringify(next));
        saved = next;
      } finally { changing = false; }
    },
  };
}
