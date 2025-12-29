import { z } from 'zod';

// Common schemas
export const uuidSchema = z.string().uuid();

// Org schemas
export const createOrgSchema = z.object({
  name: z.string().min(1).max(100),
});

export const orgSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  created_by: uuidSchema,
  created_at: z.string().datetime(),
});

// Membership schemas
export const membershipRoleSchema = z.enum(['owner', 'member']);

export const createMembershipSchema = z.object({
  org_id: uuidSchema,
  user_id: uuidSchema,
  role: membershipRoleSchema,
});

// Pocket schemas
export const createPocketSchema = z.object({
  org_id: uuidSchema,
  name: z.string().min(1).max(100),
});

export const pocketSchema = z.object({
  id: uuidSchema,
  org_id: uuidSchema,
  name: z.string(),
  created_by: uuidSchema,
  created_at: z.string().datetime(),
});

export const pocketRoleSchema = z.enum(['owner', 'member', 'client']);

export const inviteToPocketSchema = z.object({
  email: z.string().email(),
  role: pocketRoleSchema.default('member'),
});

// Source schemas
export const sourceTypeSchema = z.enum(['pdf', 'txt', 'docx', 'url']);
export const sourceStatusSchema = z.enum(['queued', 'extracting', 'chunking', 'embedding', 'ready', 'failed']);

export const createSourceUrlSchema = z.object({
  pocket_id: uuidSchema,
  url: z.string().url(),
  title: z.string().min(1).max(255).optional(),
});

export const initUploadSchema = z.object({
  pocket_id: uuidSchema,
  filename: z.string().min(1).max(255),
  mime_type: z.enum([
    'application/pdf',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ]),
  size_bytes: z.number().int().positive().max(10 * 1024 * 1024), // 10MB max
});

export const sourceSchema = z.object({
  id: uuidSchema,
  org_id: uuidSchema,
  pocket_id: uuidSchema,
  type: sourceTypeSchema,
  title: z.string(),
  url: z.string().url().nullable(),
  storage_path: z.string().nullable(),
  mime_type: z.string(),
  size_bytes: z.number().int(),
  status: sourceStatusSchema,
  error_message: z.string().nullable(),
  created_by: uuidSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

// Chunk schemas
export const chunkSchema = z.object({
  id: uuidSchema,
  org_id: uuidSchema,
  pocket_id: uuidSchema,
  source_id: uuidSchema,
  idx: z.number().int(),
  page: z.number().int().nullable(),
  text: z.string(),
  content_hash: z.string(),
  embedding: z.array(z.number()).nullable(),
  created_at: z.string().datetime(),
});

// Message schemas
export const messageRoleSchema = z.enum(['user', 'assistant']);

export const citationSchema = z.object({
  chunk_id: uuidSchema,
  source_id: uuidSchema,
  title: z.string(),
  page: z.number().int().nullable(),
  snippet: z.string(),
});

export const messageSchema = z.object({
  id: uuidSchema,
  org_id: uuidSchema,
  pocket_id: uuidSchema,
  conversation_id: uuidSchema,
  role: messageRoleSchema,
  content: z.string(),
  citations: z.array(citationSchema).nullable(),
  created_at: z.string().datetime(),
});

// Task schemas
export const taskPrioritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);
export const taskStatusSchema = z.enum(['open', 'in_progress', 'waiting', 'done', 'blocked']);

export const createTaskSchema = z.object({
  pocket_id: uuidSchema,
  title: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  due_at: z.string().datetime().optional(),
  priority: taskPrioritySchema.default('P2'),
  assignee_user_id: uuidSchema.optional(),
  linked_chunk_ids: z.array(uuidSchema).optional(),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  due_at: z.string().datetime().nullable().optional(),
  priority: taskPrioritySchema.optional(),
  status: taskStatusSchema.optional(),
  assignee_user_id: uuidSchema.nullable().optional(),
  linked_chunk_ids: z.array(uuidSchema).optional(),
});

export const taskSchema = z.object({
  id: uuidSchema,
  org_id: uuidSchema,
  pocket_id: uuidSchema,
  title: z.string(),
  description: z.string().nullable(),
  due_at: z.string().datetime().nullable(),
  priority: taskPrioritySchema,
  status: taskStatusSchema,
  assignee_user_id: uuidSchema.nullable(),
  created_by: uuidSchema,
  linked_chunk_ids: z.array(uuidSchema).nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

// Search & RAG schemas
export const searchSchema = z.object({
  pocket_id: uuidSchema,
  query: z.string().min(1).max(1000),
  limit: z.number().int().min(1).max(50).default(20),
});

export const askSchema = z.object({
  pocket_id: uuidSchema,
  query: z.string().min(1).max(2000),
  conversation_id: uuidSchema.optional(),
});

export const searchResultSchema = z.object({
  chunk_id: uuidSchema,
  source_id: uuidSchema,
  source_title: z.string(),
  source_type: sourceTypeSchema,
  page: z.number().int().nullable(),
  text: z.string(),
  score: z.number(),
});

// Settings schemas
export const updateSettingsSchema = z.object({
  org_id_default: uuidSchema.optional(),
  openrouter_api_key: z.string().optional(), // Will be encrypted before storage
});

// Pagination schemas
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

// Query params
export const listSourcesQuerySchema = z.object({
  pocket_id: uuidSchema,
  status: sourceStatusSchema.optional(),
  type: sourceTypeSchema.optional(),
}).merge(paginationSchema);

export const listTasksQuerySchema = z.object({
  pocket_id: uuidSchema.optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  overdue: z.coerce.boolean().optional(),
  assignee_user_id: uuidSchema.optional(),
}).merge(paginationSchema);

// Type exports
export type CreateOrg = z.infer<typeof createOrgSchema>;
export type CreatePocket = z.infer<typeof createPocketSchema>;
export type InviteToPocket = z.infer<typeof inviteToPocketSchema>;
export type CreateSourceUrl = z.infer<typeof createSourceUrlSchema>;
export type InitUpload = z.infer<typeof initUploadSchema>;
export type CreateTask = z.infer<typeof createTaskSchema>;
export type UpdateTask = z.infer<typeof updateTaskSchema>;
export type SearchQuery = z.infer<typeof searchSchema>;
export type AskQuery = z.infer<typeof askSchema>;
export type UpdateSettings = z.infer<typeof updateSettingsSchema>;
export type ListSourcesQuery = z.infer<typeof listSourcesQuerySchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
export type Pagination = z.infer<typeof paginationSchema>;
