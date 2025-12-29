// Database Types - matching Supabase schema

export type UUID = string;

// Org & Membership
export interface Org {
  id: UUID;
  name: string;
  created_by: UUID;
  created_at: string;
}

export type MembershipRole = 'owner' | 'member';

export interface Membership {
  id: UUID;
  org_id: UUID;
  user_id: UUID;
  role: MembershipRole;
  created_at: string;
}

// Pocket & Pocket Members
export interface Pocket {
  id: UUID;
  org_id: UUID;
  name: string;
  created_by: UUID;
  created_at: string;
}

export type PocketRole = 'owner' | 'member' | 'client';

export interface PocketMember {
  id: UUID;
  pocket_id: UUID;
  org_id: UUID;
  user_id: UUID;
  role: PocketRole;
  created_at: string;
}

// Source
export type SourceType = 'pdf' | 'txt' | 'docx' | 'url';
export type SourceStatus = 'queued' | 'extracting' | 'chunking' | 'embedding' | 'ready' | 'failed';

export interface Source {
  id: UUID;
  org_id: UUID;
  pocket_id: UUID;
  type: SourceType;
  title: string;
  url: string | null;
  storage_path: string | null;
  mime_type: string;
  size_bytes: number;
  status: SourceStatus;
  error_message: string | null;
  created_by: UUID;
  created_at: string;
  updated_at: string;
}

// Chunk
export interface Chunk {
  id: UUID;
  org_id: UUID;
  pocket_id: UUID;
  source_id: UUID;
  idx: number;
  page: number | null;
  text: string;
  content_hash: string;
  embedding: number[] | null;
  created_at: string;
}

// Conversation & Messages
export interface Conversation {
  id: UUID;
  org_id: UUID;
  pocket_id: UUID;
  created_by: UUID;
  created_at: string;
}

export type MessageRole = 'user' | 'assistant';

export interface Citation {
  chunk_id: UUID;
  source_id: UUID;
  title: string;
  page: number | null;
  snippet: string;
}

export interface Message {
  id: UUID;
  org_id: UUID;
  pocket_id: UUID;
  conversation_id: UUID;
  role: MessageRole;
  content: string;
  citations: Citation[] | null;
  created_at: string;
}

// Tasks
export type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type TaskStatus = 'open' | 'in_progress' | 'waiting' | 'done' | 'blocked';

export interface Task {
  id: UUID;
  org_id: UUID;
  pocket_id: UUID;
  title: string;
  description: string | null;
  due_at: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  assignee_user_id: UUID | null;
  created_by: UUID;
  linked_chunk_ids: UUID[] | null;
  created_at: string;
  updated_at: string;
}

// Audit Events
export type AuditEventType =
  | 'login'
  | 'logout'
  | 'pocket_create'
  | 'source_upload'
  | 'source_url_save'
  | 'pipeline_started'
  | 'pipeline_completed'
  | 'pipeline_failed'
  | 'search'
  | 'ask'
  | 'task_create'
  | 'task_update'
  | 'settings_update';

export interface AuditEvent {
  id: UUID;
  org_id: UUID;
  pocket_id: UUID | null;
  user_id: UUID | null;
  event_type: AuditEventType;
  metadata: Record<string, unknown>;
  created_at: string;
}

// User Settings
export interface UserSettings {
  user_id: UUID;
  org_id_default: UUID | null;
  openrouter_api_key_encrypted: string | null;
  created_at: string;
  updated_at: string;
}

// API Response Types
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

// Search & RAG Types
export interface SearchResult {
  chunk_id: UUID;
  source_id: UUID;
  source_title: string;
  source_type: SourceType;
  page: number | null;
  text: string;
  score: number;
}

export interface AskRequest {
  pocket_id: UUID;
  query: string;
  conversation_id?: UUID;
}

export interface AskResponse {
  answer: string;
  citations: Citation[];
  conversation_id: UUID;
  message_id: UUID;
}

// Analytics
export interface Analytics {
  total_sources: number;
  total_chunks: number;
  total_storage_bytes: number;
  estimated_embedding_tokens: number;
  sources_by_type: Record<SourceType, number>;
  sources_by_status: Record<SourceStatus, number>;
}
