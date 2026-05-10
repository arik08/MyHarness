import React, {useState} from 'react';
import {Box, Text, useInput} from 'ink';

export type TodoItem = {
	text: string;
	checked: boolean;
};

function parseTodoItems(markdown: string): TodoItem[] {
	const lines = markdown.split('\n');
	const items: TodoItem[] = [];
	for (const line of lines) {
		const m = line.match(/^\s*-\s+\[([ xX])\]\s+(.+)/);
		if (m) {
			items.push({checked: m[1].toLowerCase() === 'x', text: m[2].trim()});
		}
	}
	return items;
}

function TodoPanelInner({
	markdown,
	compact: initialCompact = false,
}: {
	markdown: string;
	compact?: boolean;
}): React.JSX.Element | null {
	const [compact, setCompact] = useState(initialCompact);
	const items = parseTodoItems(markdown);

	useInput((chunk, key) => {
		if (key.ctrl && chunk === 't') {
			setCompact((c) => !c);
		}
	});

	if (items.length === 0) {
		return null;
	}

	const done = items.filter((i) => i.checked).length;
	const total = items.length;

	if (compact) {
		return (
			<Box>
				<Text color="yellow" bold>
					{'☑ '}
				</Text>
				<Text dimColor>
					작업: {done}/{total} 완료
				</Text>
				<Text dimColor> [ctrl+t 펼치기]</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginTop={1}>
			<Box>
				<Text color="yellow" bold>
					{'☑ '}
				</Text>
				<Text bold>
					작업 목록{' '}
				</Text>
				<Text dimColor>
					({done}/{total})
				</Text>
				<Text dimColor> [ctrl+t 간단히]</Text>
			</Box>
			{items.map((item, i) => (
				<Box key={i}>
					<Text color={item.checked ? 'green' : 'white'}>
						{item.checked ? '  ☑ ' : '  ☐ '}
					</Text>
					<Text
						color={item.checked ? 'green' : undefined}
						dimColor={item.checked}
					>
						{item.text}
					</Text>
				</Box>
			))}
		</Box>
	);
}

export const TodoPanel = React.memo(TodoPanelInner);

export {parseTodoItems};
