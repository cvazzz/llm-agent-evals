export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Message {
  role: Role;
  content: string | null;
  toolCalls?: ToolCall[]; // assistant messages
  toolCallId?: string; // tool messages
  name?: string; // tool messages: tool name
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools: ToolDef[];
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
}

export interface LlmClient {
  readonly name: string;
  chat(req: ChatRequest, onText?: (delta: string) => void): Promise<ChatResult>;
}

export type AgentEvent =
  | { type: 'status'; message: string; [k: string]: unknown }
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; args: Record<string, unknown>; ok: boolean; summary: string }
  | { type: 'done'; [k: string]: unknown };
