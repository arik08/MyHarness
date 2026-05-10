import React from 'react';
import {Box, Text} from 'ink';

import type {BridgeSessionSnapshot, McpServerSnapshot, TaskSnapshot} from '../types.js';

export function SidePanel({
	status,
	tasks,
	commands,
	commandHints,
	mcpServers,
	bridgeSessions,
}: {
	status: Record<string, unknown>;
	tasks: TaskSnapshot[];
	commands: string[];
	commandHints: string[];
	mcpServers: McpServerSnapshot[];
	bridgeSessions: BridgeSessionSnapshot[];
}): React.JSX.Element {
	return (
		<Box flexDirection="column" width="32%">
			<StatusPanel status={status} />
			<TaskPanel tasks={tasks} />
			<McpPanel servers={mcpServers} />
			<BridgePanel sessions={bridgeSessions} />
			<CommandPanel commands={commands} hints={commandHints} />
		</Box>
	);
}

function StatusPanel({status}: {status: Record<string, unknown>}): React.JSX.Element {
	return (
		<>
			<Text bold>상태</Text>
			<Box flexDirection="column" borderStyle="round" paddingX={1} marginBottom={1}>
				<Text>모델: {String(status.model ?? '알 수 없음')}</Text>
				<Text>프로바이더: {String(status.provider ?? '알 수 없음')}</Text>
				<Text>인증: {String(status.auth_status ?? '알 수 없음')}</Text>
				<Text>권한: {String(status.permission_mode ?? '알 수 없음')}</Text>
				<Text>cwd: {String(status.cwd ?? '.')}</Text>
				<Text>vim: {String(Boolean(status.vim_enabled))}</Text>
				<Text>음성: {String(Boolean(status.voice_enabled))}</Text>
				<Text>음성 준비: {String(Boolean(status.voice_available))}</Text>
				<Text>빠른 모드: {String(Boolean(status.fast_mode))}</Text>
				<Text>추론 강도: {String(status.effort ?? 'medium')}</Text>
				<Text>패스: {String(status.passes ?? 1)}</Text>
			</Box>
		</>
	);
}

function TaskPanel({tasks}: {tasks: TaskSnapshot[]}): React.JSX.Element {
	const visible = tasks.slice(0, 6);
	return (
		<>
			<Text bold>작업</Text>
			<Box flexDirection="column" borderStyle="round" paddingX={1} marginBottom={1}>
				{visible.length === 0 ? (
					<Text>(없음)</Text>
				) : (
					visible.map((task) => (
						<Box key={task.id} flexDirection="column">
							<Text>
								{task.id} [{task.status}] {task.description}
							</Text>
							<Text dimColor>
								유형={task.type} 진행={task.metadata.progress ?? '-'} 메모={task.metadata.status_note ?? '-'}
							</Text>
						</Box>
					))
				)}
			</Box>
		</>
	);
}

function McpPanel({servers}: {servers: McpServerSnapshot[]}): React.JSX.Element {
	return (
		<>
			<Text bold>MCP</Text>
			<Box flexDirection="column" borderStyle="round" paddingX={1} marginBottom={1}>
				{servers.length === 0 ? (
					<Text>(없음)</Text>
				) : (
					servers.slice(0, 5).map((server) => (
						<Box key={server.name} flexDirection="column">
							<Text>
								{server.name} [{server.state}] {server.transport ?? '알 수 없음'}
							</Text>
							<Text dimColor>
								인증={String(Boolean(server.auth_configured))} 도구={String(server.tool_count ?? 0)} 리소스=
								{String(server.resource_count ?? 0)}
							</Text>
							{server.detail ? <Text dimColor>{server.detail}</Text> : null}
						</Box>
					))
				)}
			</Box>
		</>
	);
}

function BridgePanel({sessions}: {sessions: BridgeSessionSnapshot[]}): React.JSX.Element {
	return (
		<>
			<Text bold>Bridge</Text>
			<Box flexDirection="column" borderStyle="round" paddingX={1} marginBottom={1}>
				{sessions.length === 0 ? (
					<Text>(없음)</Text>
				) : (
					sessions.slice(0, 4).map((session) => (
						<Box key={session.session_id} flexDirection="column">
							<Text>
								{session.session_id} [{session.status}] pid={session.pid}
							</Text>
							<Text dimColor>{session.command}</Text>
						</Box>
					))
				)}
			</Box>
		</>
	);
}

function CommandPanel({
	commands,
	hints,
}: {
	commands: string[];
	hints: string[];
}): React.JSX.Element {
	return (
		<>
			<Text bold>명령어</Text>
			<Box flexDirection="column" borderStyle="round" paddingX={1}>
				{hints.length > 0 ? (
					hints.map((command, index) => (
						<Text key={command} color={index === 0 ? 'cyan' : undefined}>
							{command}
							{index === 0 ? '  [tab]' : ''}
						</Text>
					))
				) : commands.length > 0 ? (
					<Text>/ 를 입력하면 명령어가 표시됩니다</Text>
				) : (
					<Text>(없음)</Text>
				)}
			</Box>
		</>
	);
}
