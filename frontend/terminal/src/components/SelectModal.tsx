import React from 'react';
import {Box, Text} from 'ink';

export type SelectOption = {
	value: string;
	label: string;
	description?: string;
	active?: boolean;
};

export function SelectModal({
	title,
	options,
	selectedIndex,
}: {
	title: string;
	options: SelectOption[];
	selectedIndex: number;
}): React.JSX.Element {
	return (
		<Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1}>
			<Text bold color="cyan">{title}</Text>
			<Text> </Text>
			{options.map((opt, i) => {
				const isSelected = i === selectedIndex;
				const isCurrent = opt.active;
				return (
					<Box key={opt.value} flexDirection="row">
						<Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
							{isSelected ? '\u276F ' : '  '}
							<Text color={isSelected ? 'cyan' : undefined}>
								{opt.label}
							</Text>
						</Text>
						{isCurrent ? <Text color="green"> (현재)</Text> : null}
						{opt.description ? <Text dimColor>  {opt.description}</Text> : null}
					</Box>
				);
			})}
			<Text> </Text>
			<Text dimColor>{'\u2191\u2193'} 이동{'  '}{'\u23CE'} 선택{'  '}esc 취소</Text>
		</Box>
	);
}
