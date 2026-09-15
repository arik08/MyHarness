import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { AppStateProvider } from "../../state/app-state";
import { appReducer, initialAppState } from "../../state/reducer";
import { MessageList } from "../MessageList";
import { ModalHost } from "../ModalHost";

afterEach(cleanup);

describe("sent image attachments", () => {
  it.each(["설명해 주세요", ""])("restores thumbnails above and outside the bubble for %s", async (text) => {
    const user = userEvent.setup();
    const images = ["arbitrary.png", "다른 사진.webp"].map((name) => ({ name, path: `.myharness/client-uploads/${name}`, media_type: "image/png" }));
    const state = appReducer(initialAppState, { type: "backend_event", event: {
      type: "history_snapshot", value: "history", history_events: [{ type: "user", text: `${text} [image attachments: 2]`, display_text: text, images }],
    } });
    render(<AppStateProvider initialState={state}><MessageList /><ModalHost /></AppStateProvider>);
    const thumbnail = screen.getByRole("button", { name: "arbitrary.png 이미지 크게 보기" });
    expect(thumbnail.closest(".bubble")).toBeNull();
    expect(thumbnail.closest("article")?.firstElementChild?.className).toBe("user-message-images");
    expect(document.querySelectorAll(".user-image-attachment")).toHaveLength(2);
    expect(document.querySelectorAll(".message.user .bubble")).toHaveLength(text ? 1 : 0);
    await user.click(thumbnail);
    const dialog = screen.getByRole("dialog", { name: "arbitrary.png" });
    expect(dialog.querySelector("img")?.getAttribute("src")).toContain("%2Fclient-uploads%2Farbitrary.png");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(thumbnail);
    await user.click(thumbnail);
    fireEvent.click(document.querySelector(".modal-backdrop")!);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.error(thumbnail.querySelector("img")!);
    expect(thumbnail.hasAttribute("disabled")).toBe(true);
    expect(thumbnail.getAttribute("aria-label")).toContain("불러올 수 없습니다");
  });

  it("upgrades the optimistic image to a durable reference without duplicating the message", () => {
    let state = appReducer(initialAppState, { type: "append_message", message: {
      role: "user", text: "[test.png]", displayText: "", transcriptTexts: ["[image attachments: 1]"],
      images: [{ name: "test.png", media_type: "image/png", src: "data:image/png;base64,AAAA" }],
    } });
    state = appReducer(state, { type: "backend_event", event: { type: "transcript_item", item: {
      role: "user", text: "[image attachments: 1]", display_text: "",
      images: [{ name: "test.png", media_type: "image/png", path: ".myharness/client-uploads/test.png" }],
    } } });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].images?.[0].src).toBeUndefined();
    expect(state.messages[0].images?.[0].path).toContain("test.png");
  });
});
