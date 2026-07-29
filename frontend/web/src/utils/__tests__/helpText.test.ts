import { describe, expect, it } from "vitest";

import { frontendHelpText } from "../helpText";


describe("frontendHelpText", () => {
  it("shows skill-mcp wrappers only in MCP and deduplicates their raw servers", () => {
    const text = frontendHelpText({
      commands: [],
      plugins: [],
      skills: [
        {
          name: "regular-skill",
          description: "ordinary skill",
          source: "project",
          enabled: true,
        },
        {
          name: "vector-db-rag",
          description: "wrapped vector MCP",
          source: "skill-mcp:vector_db",
          enabled: true,
        },
      ],
      mcpServers: [
        {
          name: "vector_db",
          state: "ready",
          transport: "stdio",
          description: "raw vector MCP",
        },
        {
          name: "worldbank",
          state: "ready",
          transport: "stdio",
          description: "raw World Bank MCP",
        },
      ],
    });

    const skillsSection = text.split("사용 가능한 스킬:", 2)[1].split("MCP 서버:", 2)[0];
    const mcpSection = text.split("MCP 서버:", 2)[1].split("플러그인:", 2)[0];

    expect(skillsSection).toContain("regular-skill");
    expect(skillsSection).not.toContain("vector-db-rag");
    expect(mcpSection).toContain("vector-db-rag");
    expect(mcpSection).toContain("worldbank");
    expect(mcpSection).not.toContain("raw vector MCP");
    expect(mcpSection.match(/vector-db-rag/g)).toHaveLength(1);
  });
});
