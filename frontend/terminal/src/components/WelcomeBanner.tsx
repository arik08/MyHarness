import React from 'react';
import {Box, Text} from 'ink';

import {useTheme} from '../theme/ThemeContext.js';

const VERSION = '0.1.0';

// prettier-ignore
const LOGO = [
	' ██████╗ ██╗  ██╗    ███╗   ███╗██╗   ██╗    ██╗  ██╗ █████╗ ██████╗ ███╗   ██╗███████╗███████╗███████╗██╗',
	'██╔═══██╗██║  ██║    ████╗ ████║╚██╗ ██╔╝    ██║  ██║██╔══██╗██╔══██╗████╗  ██║██╔════╝██╔════╝██╔════╝██║',
	'██║   ██║███████║    ██╔████╔██║ ╚████╔╝     ███████║███████║██████╔╝██╔██╗ ██║█████╗  ███████╗███████╗██║',
	'██║   ██║██╔══██║    ██║╚██╔╝██║  ╚██╔╝      ██╔══██║██╔══██║██╔══██╗██║╚██╗██║██╔══╝  ╚════██║╚════██║╚═╝',
	'╚██████╔╝██║  ██║    ██║ ╚═╝ ██║   ██║       ██║  ██║██║  ██║██║  ██║██║ ╚████║███████╗███████║███████║██╗',
	' ╚═════╝ ╚═╝  ╚═╝    ╚═╝     ╚═╝   ╚═╝       ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝╚══════╝╚═╝',
];

export function WelcomeBanner(): React.JSX.Element {
	const {theme} = useTheme();

	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box flexDirection="column" paddingX={0}>
				{LOGO.map((line, i) => (
					<Text key={i} color={theme.colors.primary} bold>{line}</Text>
				))}
				<Text> </Text>
				<Text>
					<Text dimColor> 사무계 업무용 AI 에이전트</Text>
					<Text dimColor>{'  '}v{VERSION}</Text>
				</Text>
				<Text> </Text>
				<Text>
					<Text dimColor> </Text>
					<Text color={theme.colors.primary}>/help</Text>
					<Text dimColor> 명령어</Text>
					<Text dimColor>{'  '}|{'  '}</Text>
					<Text color={theme.colors.primary}>/model</Text>
					<Text dimColor> 전환</Text>
					<Text dimColor>{'  '}|{'  '}</Text>
					<Text color={theme.colors.primary}>Ctrl+C</Text>
					<Text dimColor> 종료</Text>
				</Text>
			</Box>
		</Box>
	);
}
