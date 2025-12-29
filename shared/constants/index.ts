// API Constants
export const API_VERSION = 'v1';

// File upload limits
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

export const ALLOWED_EXTENSIONS = ['.pdf', '.txt', '.docx'] as const;

export const MIME_TO_SOURCE_TYPE: Record<string, 'pdf' | 'txt' | 'docx'> = {
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

// Chunking configuration
export const CHUNK_TARGET_TOKENS = 600;
export const CHUNK_OVERLAP_TOKENS = 100;
export const CHARS_PER_TOKEN_ESTIMATE = 4;

// Embedding configuration
export const EMBEDDING_DIMENSION = 3072; // text-embedding-3-large
export const EMBEDDING_BATCH_SIZE = 100;

// Search configuration
export const VECTOR_SEARCH_TOP_K = 20;
export const FTS_SEARCH_TOP_K = 20;
export const SEARCH_RESULT_LIMIT = 10;
export const RAG_CONTEXT_CHUNKS = 10;

// Hybrid search weights
export const VECTOR_WEIGHT = 0.7;
export const FTS_WEIGHT = 0.3;

// Rate limiting
export const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
export const RATE_LIMITS = {
  default: 100,
  search: 30,
  ask: 20,
  upload: 10,
} as const;

// Task priorities display
export const PRIORITY_LABELS: Record<string, string> = {
  P0: 'Critical',
  P1: 'High',
  P2: 'Medium',
  P3: 'Low',
};

// Task status display
export const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  waiting: 'Waiting',
  done: 'Done',
  blocked: 'Blocked',
};

// Source status display
export const SOURCE_STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  extracting: 'Extracting text...',
  chunking: 'Processing chunks...',
  embedding: 'Creating embeddings...',
  ready: 'Ready',
  failed: 'Failed',
};

// OpenRouter models
export const DEFAULT_EMBED_MODEL = 'openai/text-embedding-3-large';
export const DEFAULT_CHAT_MODEL = 'google/gemma-3-27b-it:free';
export const FALLBACK_CHAT_MODEL = 'openai/gpt-oss-120b:free';

// Supabase Storage bucket
export const STORAGE_BUCKET = 'sources';

// Signed URL expiry
export const SIGNED_URL_EXPIRY_SECONDS = 3600; // 1 hour
