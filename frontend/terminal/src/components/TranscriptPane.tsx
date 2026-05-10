import React from 'react';
import {Box, Text} from 'ink';

import type {TranscriptItem} from '../types.js';

export function TranscriptPane({
	items,
	assistantBuffer,
}: {
	items: TranscriptItem[];
	assistantBuffer: string;
}): React.JSX.Element {
	const visible = items.slice(-24);
	return (
		<Box flexDirection="column" width="68%" paddingRight={1}>
			<Text bold>대화 기록</Text>
			<Box flexDirection="column" borderStyle="round" paddingX={1} minHeight={24}>
				{visible.map((item, index) => (
					<Text key={`${index}-${item.role}`} color={roleColor(item.role)}>
						{labelFor(item)} {item.text}
					</Text>
				))}
				{assistantBuffer ? <Text color="green">어시스턴트&gt; {assistantBuffer}</Text> : null}
			</Box>
		</Box>
	);
}

function labelFor(item: TranscriptItem): string {
	const kind = item.kind === 'steering' ? ':스티어링' : item.kind === 'queued' ? ':대기열' : '';
	const role = item.role;
	switch (role) {
		case 'tool':
			return '도구>';
		case 'tool_result':
			return '도구결과>';
		case 'assistant':
			return `어시스턴트${kind}>`;
		case 'user':
			return `사용자${kind}>`;
		case 'system':
			return `시스템${kind}>`;
		case 'log':
			return `로그${kind}>`;
		default:
			return `${role}${kind}>`;
	}
}

function roleColor(role: TranscriptItem['role']): string | undefined {
	if (role === 'assistant') {
		return 'green';
	}
	if (role === 'tool') {
		return 'cyan';
	}
	if (role === 'tool_result') {
		return 'yellow';
	}
	if (role === 'system') {
		return 'magenta';
	}
	if (role === 'log') {
		return 'gray';
	}
	return undefined;
}
