export type ToolIdentity = { tool_call_id?: unknown; tool_call_index?: unknown; tool_name?: unknown };
export function backendToolCallIndex(event: ToolIdentity): number | null;
export function toolCallKey(event: ToolIdentity): string;
