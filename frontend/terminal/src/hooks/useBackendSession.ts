import {startTransition, useEffect, useMemo, useRef, useState} from 'react';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import readline from 'node:readline';

import type {
	BackendEvent,
	BridgeSessionSnapshot,
	FrontendConfig,
	McpServerSnapshot,
	SelectOptionPayload,
	SkillSnapshot,
	SwarmNotificationSnapshot,
	SwarmTeammateSnapshot,
	TaskSnapshot,
	TranscriptItem,
} from '../types.js';

const PROTOCOL_PREFIX = 'OHJSON:';
const ASSISTANT_DELTA_FLUSH_MS = 50;
const ASSISTANT_DELTA_FLUSH_CHARS = 384;
const TRANSCRIPT_EVENT_FLUSH_MS = 50;

const stableStringify = (value: unknown): string => JSON.stringify(value);

export function useBackendSession(config: FrontendConfig, onExit: (code?: number | null) => void) {
	const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
	const [assistantBuffer, setAssistantBuffer] = useState('');
	const [status, setStatus] = useState<Record<string, unknown>>({});
	const [tasks, setTasks] = useState<TaskSnapshot[]>([]);
	const [commands, setCommands] = useState<string[]>([]);
	const [skills, setSkills] = useState<SkillSnapshot[]>([]);
	const [mcpServers, setMcpServers] = useState<McpServerSnapshot[]>([]);
	const [bridgeSessions, setBridgeSessions] = useState<BridgeSessionSnapshot[]>([]);
	const [modal, setModal] = useState<Record<string, unknown> | null>(null);
	const [selectRequest, setSelectRequest] = useState<{title: string; command: string; options: SelectOptionPayload[]} | null>(null);
	const [busy, setBusy] = useState(false);
	const [busyLabel, setBusyLabel] = useState<string | undefined>(undefined);
	const [ready, setReady] = useState(false);
	const [todoMarkdown, setTodoMarkdown] = useState('');
	const [swarmTeammates, setSwarmTeammates] = useState<SwarmTeammateSnapshot[]>([]);
	const [swarmNotifications, setSwarmNotifications] = useState<SwarmNotificationSnapshot[]>([]);
	const statusRef = useRef<Record<string, unknown>>({});
	const childRef = useRef<ChildProcessWithoutNullStreams | null>(null);
	const sentInitialPrompt = useRef(false);
	const lastStatusSnapshotRef = useRef('');
	const lastTasksSnapshotRef = useRef('');
	const lastMcpSnapshotRef = useRef('');
	const lastBridgeSnapshotRef = useRef('');

	// Streaming deltas can arrive one token at a time; updating Ink state for each
	// delta causes heavy re-rendering/flicker. Buffer and flush at ~30fps.
	const assistantBufferRef = useRef('');
	const pendingAssistantDeltaRef = useRef('');
	const assistantFlushTimerRef = useRef<NodeJS.Timeout | null>(null);
	const pendingTranscriptItemsRef = useRef<TranscriptItem[]>([]);
	const transcriptFlushTimerRef = useRef<NodeJS.Timeout | null>(null);

	const flushAssistantDelta = (): void => {
		const pending = pendingAssistantDeltaRef.current;
		if (!pending) {
			return;
		}
		pendingAssistantDeltaRef.current = '';
		assistantBufferRef.current += pending;
		startTransition(() => {
			setAssistantBuffer(assistantBufferRef.current);
		});
	};

	const flushTranscriptItems = (): void => {
		const pending = pendingTranscriptItemsRef.current;
		if (pending.length === 0) {
			return;
		}
		pendingTranscriptItemsRef.current = [];
		startTransition(() => {
			setTranscript((items) => [...items, ...pending]);
		});
	};

	const queueTranscriptItem = (item: TranscriptItem): void => {
		pendingTranscriptItemsRef.current.push(item);
		if (!transcriptFlushTimerRef.current) {
			transcriptFlushTimerRef.current = setTimeout(() => {
				transcriptFlushTimerRef.current = null;
				flushTranscriptItems();
			}, TRANSCRIPT_EVENT_FLUSH_MS);
		}
	};

	const clearAssistantDelta = (): void => {
		pendingAssistantDeltaRef.current = '';
		assistantBufferRef.current = '';
		if (assistantFlushTimerRef.current) {
			clearTimeout(assistantFlushTimerRef.current);
			assistantFlushTimerRef.current = null;
		}
		setAssistantBuffer('');
	};

	const clearPendingTranscriptItems = (): void => {
		pendingTranscriptItemsRef.current = [];
		if (transcriptFlushTimerRef.current) {
			clearTimeout(transcriptFlushTimerRef.current);
			transcriptFlushTimerRef.current = null;
		}
	};

	const sendRequest = (payload: Record<string, unknown>): void => {
		const child = childRef.current;
		if (!child || child.stdin.destroyed) {
			return;
		}
		child.stdin.write(JSON.stringify(payload) + '\n');
	};

	useEffect(() => {
		const [command, ...args] = config.backend_command;
		const useDetachedGroup = process.platform !== 'win32';
		const child = spawn(command, args, {
			stdio: ['pipe', 'pipe', 'inherit'],
			env: process.env,
			// On Windows, a detached child gets its own console window and can
			// flash open/closed. Keep detached groups for POSIX only.
			detached: useDetachedGroup,
			windowsHide: true,
		});
		childRef.current = child;

		const reader = readline.createInterface({input: child.stdout});
		reader.on('line', (line) => {
			if (!line.startsWith(PROTOCOL_PREFIX)) {
				queueTranscriptItem({role: 'log', text: line});
				return;
			}
			const event = JSON.parse(line.slice(PROTOCOL_PREFIX.length)) as BackendEvent;
			handleEvent(event);
		});

		child.on('exit', (code) => {
			flushTranscriptItems();
			queueTranscriptItem({role: 'system', text: `백엔드가 종료되었습니다. 코드: ${code ?? 0}`});
			process.exitCode = code ?? 0;
			onExit(code);
		});

		// Ensure child processes are killed on parent exit (prevents stale processes)
		const killChild = (): void => {
			if (!child.killed) {
				// Kill the whole process group on POSIX. On Windows, terminate the
				// direct child to avoid relying on negative PIDs.
				try {
					if (useDetachedGroup && child.pid) {
						process.kill(-child.pid, 'SIGTERM');
					} else {
						child.kill('SIGTERM');
					}
				} catch {
					child.kill('SIGTERM');
				}
			}
			if (assistantFlushTimerRef.current) {
				clearTimeout(assistantFlushTimerRef.current);
				assistantFlushTimerRef.current = null;
			}
			clearPendingTranscriptItems();
		};
		process.on('exit', killChild);
		process.on('SIGINT', killChild);
		process.on('SIGTERM', killChild);

		return () => {
			reader.close();
			killChild();
			process.removeListener('exit', killChild);
			process.removeListener('SIGINT', killChild);
			process.removeListener('SIGTERM', killChild);
		};
	}, []);

	const handleEvent = (event: BackendEvent): void => {
		if (event.type === 'ready') {
			setReady(true);
			const statusSnapshot = stableStringify(event.state ?? {});
			lastStatusSnapshotRef.current = statusSnapshot;
			const nextStatus = event.state ?? {};
			statusRef.current = nextStatus;
			startTransition(() => {
				setStatus(nextStatus);
			});
			const tasksSnapshot = stableStringify(event.tasks ?? []);
			lastTasksSnapshotRef.current = tasksSnapshot;
			startTransition(() => {
				setTasks(event.tasks ?? []);
			});
			setCommands((event.commands ?? []).map((command) => {
				if (typeof command === 'string') {
					return command;
				}
				const record = command as Record<string, unknown>;
				return typeof record.name === 'string' ? record.name : '';
			}).filter(Boolean));
			setSkills(event.skills ?? []);
			const mcpSnapshot = stableStringify(event.mcp_servers ?? []);
			lastMcpSnapshotRef.current = mcpSnapshot;
			startTransition(() => {
				setMcpServers(event.mcp_servers ?? []);
			});
			const bridgeSnapshot = stableStringify(event.bridge_sessions ?? []);
			lastBridgeSnapshotRef.current = bridgeSnapshot;
			startTransition(() => {
				setBridgeSessions(event.bridge_sessions ?? []);
			});
			if (config.initial_prompt && !sentInitialPrompt.current) {
				sentInitialPrompt.current = true;
				sendRequest({type: 'submit_line', line: config.initial_prompt});
				setBusy(true);
			}
			return;
		}
		if (event.type === 'state_snapshot') {
			const statusSnapshot = stableStringify(event.state ?? {});
			if (statusSnapshot !== lastStatusSnapshotRef.current) {
				lastStatusSnapshotRef.current = statusSnapshot;
				const nextStatus = event.state ?? {};
				statusRef.current = nextStatus;
				startTransition(() => {
					setStatus(nextStatus);
				});
			}
			const mcpSnapshot = stableStringify(event.mcp_servers ?? []);
			if (mcpSnapshot !== lastMcpSnapshotRef.current) {
				lastMcpSnapshotRef.current = mcpSnapshot;
				startTransition(() => {
					setMcpServers(event.mcp_servers ?? []);
				});
			}
			const bridgeSnapshot = stableStringify(event.bridge_sessions ?? []);
			if (bridgeSnapshot !== lastBridgeSnapshotRef.current) {
				lastBridgeSnapshotRef.current = bridgeSnapshot;
				startTransition(() => {
					setBridgeSessions(event.bridge_sessions ?? []);
				});
			}
			return;
		}
		if (event.type === 'tasks_snapshot') {
			const tasksSnapshot = stableStringify(event.tasks ?? []);
			if (tasksSnapshot !== lastTasksSnapshotRef.current) {
				lastTasksSnapshotRef.current = tasksSnapshot;
				startTransition(() => {
					setTasks(event.tasks ?? []);
				});
			}
			return;
		}
		if (event.type === 'transcript_item' && event.item) {
			queueTranscriptItem(event.item as TranscriptItem);
			return;
		}
		if (event.type === 'status') {
			const message = event.message?.trim();
			if (!message) {
				return;
			}
			queueTranscriptItem({role: 'status', text: message});
			setBusy(true);
			setBusyLabel(message);
			return;
		}
		if (event.type === 'compact_progress') {
			const phase = String(event.compact_phase ?? '');
			const trigger = String(event.compact_trigger ?? '');
			const attempt = event.attempt != null ? Number(event.attempt) : undefined;
			if (phase === 'hooks_start') {
				setBusyLabel(
					trigger === 'reactive'
						? '재시도 압축을 준비하는 중...'
						: '대화 압축을 준비하는 중...',
				);
			} else if (phase === 'context_collapse_start') {
				setBusyLabel('큰 컨텍스트를 압축하는 중...');
			} else if (phase === 'context_collapse_end') {
				setBusyLabel('컨텍스트 압축 완료...');
			} else if (phase === 'session_memory_start') {
				setBusyLabel('이전 대화를 요약하는 중...');
			} else if (phase === 'compact_start') {
				setBusyLabel(
					trigger === 'reactive'
						? '컨텍스트가 너무 큽니다. 압축 후 재시도하는 중...'
						: '대화 메모리를 압축하는 중...',
				);
			} else if (phase === 'compact_retry') {
				setBusyLabel(attempt ? `압축 재시도 중 (${attempt})...` : '압축 재시도 중...');
			} else if (phase === 'compact_end') {
				setBusyLabel('압축 완료. 계속 진행 중...');
			} else if (phase === 'compact_failed') {
				setBusyLabel('압축 실패. 압축 없이 계속 진행 중...');
			}
			if (event.message) {
				queueTranscriptItem({role: 'status', text: event.message!});
			}
			return;
		}
		if (event.type === 'assistant_delta') {
			const delta = event.message ?? '';
			if (!delta) {
				return;
			}
			const isCodexStyle = String(statusRef.current.output_style ?? 'default') === 'codex';
			if (isCodexStyle) {
				// Keep collecting text for assistant_complete fallback, but avoid
				// token-level rerenders in compact codex mode.
				assistantBufferRef.current += delta;
				return;
			}
			pendingAssistantDeltaRef.current += delta;
			if (pendingAssistantDeltaRef.current.length >= ASSISTANT_DELTA_FLUSH_CHARS) {
				flushAssistantDelta();
				return;
			}
			if (!assistantFlushTimerRef.current) {
				assistantFlushTimerRef.current = setTimeout(() => {
					assistantFlushTimerRef.current = null;
					flushAssistantDelta();
				}, ASSISTANT_DELTA_FLUSH_MS);
			}
			return;
		}
		if (event.type === 'assistant_complete') {
			if (assistantFlushTimerRef.current) {
				clearTimeout(assistantFlushTimerRef.current);
				assistantFlushTimerRef.current = null;
			}
			flushTranscriptItems();
			const isCodexStyle = String(statusRef.current.output_style ?? 'default') === 'codex';
			if (isCodexStyle) {
				if (pendingAssistantDeltaRef.current) {
					assistantBufferRef.current += pendingAssistantDeltaRef.current;
					pendingAssistantDeltaRef.current = '';
				}
			} else {
				flushAssistantDelta();
			}
			const text = event.message ?? assistantBufferRef.current;
			startTransition(() => {
				setTranscript((items) => [...items, {role: 'assistant', text}]);
			});
			clearAssistantDelta();
			// Do NOT reset busy here: tool calls may follow this event.
			// busy is reset by line_complete (the true end-of-turn signal).
			setBusyLabel(undefined);
			return;
		}
		if (event.type === 'line_complete') {
			// Final end-of-turn: clear everything, stop spinner.
			clearAssistantDelta();
			setTodoMarkdown('');
			setBusy(false);
			setBusyLabel(undefined);
			return;
		}
		if ((event.type === 'tool_started' || event.type === 'tool_completed') && event.item) {
			if (event.type === 'tool_started') {
				setBusy(true);
				setBusyLabel(`${event.tool_name ?? '도구'} 실행 중...`);
			} else {
				setBusyLabel('처리 중...');
			}
			const enrichedItem: TranscriptItem = {
				...event.item,
				tool_name: event.item.tool_name ?? event.tool_name ?? undefined,
				tool_input: event.item.tool_input ?? undefined,
				is_error: event.item.is_error ?? event.is_error ?? undefined,
			};
			queueTranscriptItem(enrichedItem);
			return;
		}
		if (event.type === 'clear_transcript') {
			flushTranscriptItems();
			clearPendingTranscriptItems();
			setTranscript([]);
			clearAssistantDelta();
			setBusyLabel(undefined);
			return;
		}
		if (event.type === 'select_request') {
			const m = event.modal ?? {};
			setSelectRequest({
				title: String(m.title ?? '선택'),
				command: String(m.command ?? ''),
				options: event.select_options ?? [],
			});
			return;
		}
		if (event.type === 'modal_request') {
			setModal(event.modal ?? null);
			return;
		}
		if (event.type === 'error') {
			flushTranscriptItems();
			queueTranscriptItem({role: 'system', text: `오류: ${event.message ?? '알 수 없는 오류'}`});
			clearAssistantDelta();
			setBusy(false);
			setBusyLabel(undefined);
			return;
		}
		if (event.type === 'todo_update') {
			if (event.todo_markdown != null) {
				startTransition(() => {
					setTodoMarkdown(event.todo_markdown);
				});
			}
			return;
		}
		if (event.type === 'swarm_status') {
			if (event.swarm_teammates != null) {
				startTransition(() => {
					setSwarmTeammates(event.swarm_teammates);
				});
			}
			if (event.swarm_notifications != null) {
				startTransition(() => {
					setSwarmNotifications((prev) => [...prev, ...event.swarm_notifications!].slice(-20));
				});
			}
			return;
		}
		if (event.type === 'plan_mode_change') {
			if (event.plan_mode != null) {
				startTransition(() => {
					setStatus((s) => {
						const next = {...s, permission_mode: event.plan_mode};
						statusRef.current = next;
						return next;
					});
				});
			}
			return;
		}
		if (event.type === 'shutdown') {
			onExit(0);
		}
	};

	return useMemo(
		() => ({
			transcript,
			assistantBuffer,
			status,
			tasks,
			commands,
			skills,
			mcpServers,
			bridgeSessions,
			modal,
			selectRequest,
			busy,
			busyLabel,
			ready,
			todoMarkdown,
			swarmTeammates,
			swarmNotifications,
			setModal,
			setSelectRequest,
			setBusy,
			sendRequest,
		}),
		[assistantBuffer, bridgeSessions, busy, busyLabel, commands, mcpServers, modal, ready, selectRequest, skills, status, swarmNotifications, swarmTeammates, tasks, todoMarkdown, transcript]
	);
}
