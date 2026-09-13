import { isIP } from "node:net";

// Log user actions and one terminal event with IP/title, never streaming/tool content.
export function createActivityLog(write = console.log) {
  const pending = new WeakSet();
  const connections = new WeakMap();
  const dailyCounts = new Map();
  let countDate = "";
  function log(session, message, includeTitle = true) {
    const address = String(session.clientAddress || "").trim();
    const ip = isIP(address) ? address : "확인 불가";
    const title = String(session.title || "").replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").trim() || "새 대화";
    const now = new Date();
    const date = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
    if (date !== countDate) {
      dailyCounts.clear();
      countDate = date;
    }
    const count = (dailyCounts.get(ip) || 0) + 1;
    dailyCounts.set(ip, count);
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((part) => String(part).padStart(2, "0")).join(":");
    write(`[${time}] [${ip}] [${count}]${includeTitle ? ` [${title}]` : ""} ${message}`);
  }
  return {
    connected(session, clientAddress = session.clientAddress) {
      let addresses = connections.get(session);
      if (!addresses) {
        addresses = new Map();
        connections.set(session, addresses);
      }
      let state = addresses.get(clientAddress);
      if (!state) {
        state = { count: 0, timer: null };
        addresses.set(clientAddress, state);
        log({ ...session, clientAddress }, "접속", false);
      }
      clearTimeout(state.timer);
      state.count += 1;
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        state.count -= 1;
        if (state.count > 0) return;
        state.timer = setTimeout(() => {
          addresses.delete(clientAddress);
          log({ ...session, clientAddress }, "접속 종료", false);
        }, 5000);
        state.timer.unref?.();
      };
    },
    received(session, message = "메시지 접수") {
      pending.add(session);
      log(session, message);
    },
    event(session, type) {
      const message = {
        line_complete: "응답 완료",
        error: "응답 오류 · 화면에서 상세 내용을 확인하세요.",
        shutdown: "대화 연결 종료",
        cancel: "중단 요청 접수",
      }[type];
      if (!message || !pending.delete(session)) return;
      log(session, message);
    },
  };
}
