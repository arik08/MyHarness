import React from 'react';
import {Box, Text} from 'ink';

export function Footer({status, taskCount}: {status: Record<string, unknown>; taskCount: number}): React.JSX.Element {
	return (
		<Box marginTop={1}>
			<Text dimColor>
				모델={String(status.model ?? '알 수 없음')} 프로바이더={String(status.provider ?? '알 수 없음')} 인증=
				{String(status.auth_status ?? '알 수 없음')} 권한={String(status.permission_mode ?? '알 수 없음')} 작업=
				{String(taskCount)} mcp={String(status.mcp_connected ?? 0)}/{String(status.mcp_failed ?? 0)} 브리지=
				{String(status.bridge_sessions ?? 0)} vim={String(Boolean(status.vim_enabled))} 음성=
				{String(Boolean(status.voice_enabled))} 추론={String(status.effort ?? '없음')} 패스=
				{String(status.passes ?? 1)}
			</Text>
		</Box>
	);
}
