import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandHelpMessage } from "../CommandHelpMessage";
import { Composer } from "../Composer";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { sendBackendRequest } from "../../api/messages";

vi.mock("../../api/messages", () => ({
  cancelMessage: vi.fn().mockResolvedValue({ ok: true }),
  sendBackendRequest: vi.fn().mockResolvedValue({ ok: true }),
  sendMessage: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../../api/session", () => ({
  startSession: vi.fn().mockResolvedValue({ sessionId: "session-new" }),
}));

function SkillsSnapshotButton() {
  const { dispatch } = useAppState();
  return (
    <button
      type="button"
      onClick={() => dispatch({
        type: "backend_event",
        event: {
          type: "skills_snapshot",
          skills: [
            { name: "ship", description: "Shipping checklist", source: "project", enabled: false },
            { name: "review", description: "Review checklist", source: "project", enabled: true },
          ],
        },
      })}
    >
      snapshot
    </button>
  );
}

describe("CommandHelpMessage", () => {
  beforeEach(() => {
    vi.mocked(sendBackendRequest).mockClear();
  });

  it("updates the visible skill state when the backend snapshot changes", async () => {
    const user = userEvent.setup();
    const helpText = [
      "사용 가능한 스킬:",
      "- ship [project] [활성]: Shipping checklist",
      "- review [project] [활성]: Review checklist",
      "",
      "사용 가능한 명령어:",
      "- /help 도움말",
    ].join("\n");

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          skills: [
            { name: "ship", description: "Shipping checklist", source: "project", enabled: true },
            { name: "review", description: "Review checklist", source: "project", enabled: true },
          ],
        }}
      >
        <CommandHelpMessage text={helpText} />
        <SkillsSnapshotButton />
        <Composer />
      </AppStateProvider>,
    );

    const shipCard = screen.getByRole("button", { name: /ship/ });
    await user.click(shipCard);
    expect(sendBackendRequest).toHaveBeenCalledWith(
      "session-1",
      expect.any(String),
      { type: "set_skill_enabled", value: "ship", enabled: false },
    );

    await user.click(screen.getByRole("button", { name: "snapshot" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /ship/ }).textContent).toContain("Inactive"));

    const input = screen.getByPlaceholderText("메세지를 입력하세요...");
    await user.type(input, "$");
    expect(screen.queryByRole("option", { name: /\$ship/ })).toBeNull();
    expect(screen.getByRole("option", { name: /\$review/ })).toBeTruthy();
  });
});
