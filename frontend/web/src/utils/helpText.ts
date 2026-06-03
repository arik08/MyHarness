import type { CommandItem, McpServerItem, PluginItem, SkillItem } from "../types/backend";

function isSkillMcpSource(source: string) {
  return /^(skill-mcp(?::|$)|mcp:)/i.test(String(source || "").trim());
}

export function frontendHelpText({
  commands,
  skills,
  mcpServers,
  plugins,
}: {
  commands: CommandItem[];
  skills: SkillItem[];
  mcpServers: McpServerItem[];
  plugins: PluginItem[];
}) {
  const commandLines = commands.length
    ? commands
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((command) => {
          const name = command.name.startsWith("/") ? command.name : `/${command.name}`;
          return `${name} ${command.description || "명령어를 실행합니다"}`;
        })
    : ["(사용 가능한 명령어가 없습니다)"];
  const skillLines = skills
    .filter((skill) => !isSkillMcpSource(skill.source || ""))
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((skill) => {
      const source = skill.source || "skill";
      const status = skill.enabled === false ? "비활성" : "활성";
      return `- ${skill.name} [${source}] [${status}]: ${skill.description || source}`;
    });
  const skillMcpLines = skills
    .filter((skill) => isSkillMcpSource(skill.source || ""))
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((skill) => {
      const status = skill.enabled === false ? "비활성" : "활성";
      return `- ${skill.name} [${status}] (skill-mcp): ${skill.description || "MCP server"}`;
    });
  const mcpLines = [
    ...mcpServers
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((server) => {
        const state = String(server.state || "").trim();
        const disabled = /^(disabled|비활성)$/i.test(state);
        const status = disabled ? "비활성" : "활성";
        const transport = server.transport || state || "mcp";
        const detail = server.detail || [
          typeof server.tool_count === "number" ? `도구 ${server.tool_count}개` : "",
          typeof server.resource_count === "number" ? `리소스 ${server.resource_count}개` : "",
        ].filter(Boolean).join(", ");
        return `- ${server.name} [${status}] (${transport})${detail ? `: ${detail}` : ""}`;
      }),
    ...skillMcpLines,
  ];
  const pluginLines = plugins
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((plugin) => {
      const status = plugin.enabled === false ? "비활성" : "활성";
      return `- ${plugin.name} [${status}]: ${plugin.description || "Plugin"}`;
    });

  return [
    "입력 단축키:",
    "- !: 로컬 CLI 명령어를 바로 실행합니다.",
    "- @: 현재 프로젝트의 파일을 선택해 프롬프트에 첨부하거나 참조합니다.",
    "- $: 사용할 스킬, MCP, 플러그인을 선택해 프롬프트에 넣습니다.",
    "- /: 슬래시 명령어를 선택하거나 실행합니다.",
    "- Enter: 답변 중에는 스티어링 지시를 보내고, 대기 중에는 메시지를 전송합니다.",
    "- Ctrl+Enter: 답변 중에는 다음 질문으로 대기열에 추가하고, 대기 중에는 메시지를 전송합니다.",
    "- Shift+Enter: 입력란에서 줄바꿈합니다.",
    "- Ctrl+Shift+O: 새 채팅을 엽니다.",
    "- Shift+Tab: 계획모드를 켜거나 끕니다.",
    "",
    "알아두면 좋은 기능:",
    "- 채팅 입력란에 이미지를 붙여넣으면 첨부 이미지로 전송되고, 첨부 칩에서 바로 미리볼 수 있습니다.",
    "- 20줄을 초과한 긴 글은 입력창 위에 접힌 항목으로 표시되고, 전송 시 원문 전체가 그대로 포함됩니다.",
    "- 에이전트가 만든 HTML, Markdown, CSV, 이미지, PDF 산출물은 답변 카드나 오른쪽 패널에서 바로 미리볼 수 있습니다.",
    "- Shift+Tab으로 계획모드를 켜고 꺼도 작성 중인 초안, 이미지 첨부, 긴 붙여넣기 내용은 유지됩니다.",
    "- 체크리스트가 생기면 입력창 옆 아이콘으로 접고 펼치며 진행 상황을 확인할 수 있습니다.",
    "",
    "사용 가능한 명령어:",
    ...commandLines,
    "",
    "사용 가능한 스킬:",
    ...(skillLines.length ? skillLines : ["(사용자 스킬이 없습니다)"]),
    "",
    "MCP 서버:",
    ...(mcpLines.length ? mcpLines : ["(설정된 MCP 서버가 없습니다)"]),
    "",
    "플러그인:",
    ...(pluginLines.length ? pluginLines : ["(발견된 플러그인이 없습니다)"]),
    "",
    "전환 사용법: /skills toggle NAME, /mcp toggle NAME, /plugin toggle NAME",
  ].join("\n");
}
