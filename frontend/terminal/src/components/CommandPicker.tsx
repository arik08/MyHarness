import React from 'react';
import {Box, Text} from 'ink';

function CommandPickerInner({
	hints,
	selectedIndex,
	title = 'Commands',
}: {
	hints: string[];
	selectedIndex: number;
	title?: string;
}): React.JSX.Element | null {
	if (hints.length === 0) {
		return null;
	}

	return (
		<Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1} marginBottom={0}>
			<Text dimColor>{title}</Text>
			{hints.map((hint, i) => {
				const isSelected = i === selectedIndex;
				return (
					<Box key={hint}>
						<Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
							{isSelected ? '> ' : '  '}
							{hint}
						</Text>
					</Box>
				);
			})}
			<Text dimColor>up/down navigate  enter select  esc dismiss</Text>
		</Box>
	);
}

export const CommandPicker = React.memo(CommandPickerInner);
