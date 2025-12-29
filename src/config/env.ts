import { z } from 'zod';

const envSchema = z.object({
  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Redis
  REDIS_URL: z.string().min(1),

  // LLM Configuration - supports OpenRouter, Ollama, LM Studio, vLLM, etc.
  // If LLM_BASE_URL is set, it takes precedence over OPENROUTER_BASE_URL
  LLM_BASE_URL: z.string().url().optional(),
  LLM_API_KEY: z.string().optional(),

  // OpenRouter (default if LLM_BASE_URL not set)
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  OPENROUTER_EMBED_MODEL: z.string().default('openai/text-embedding-3-small'),
  OPENROUTER_CHAT_MODEL: z.string().default('google/gemma-3-27b-it:free'),
  OPENROUTER_FALLBACK_CHAT_MODEL: z.string().default('openai/gpt-4o-mini'),

  // Embedding model (can be different from chat model provider)
  EMBED_BASE_URL: z.string().url().optional(),
  EMBED_API_KEY: z.string().optional(),
  EMBED_MODEL: z.string().optional(),

  // Encryption
  MASTER_KEY: z.string().min(32).optional(),

  // Server
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Sentry
  SENTRY_DSN: z.string().optional(),

  // Rate limiting
  RATE_LIMIT_ENABLED: z.coerce.boolean().default(true),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  
  if (!result.success) {
    console.error('❌ Invalid environment variables:');
    console.error(result.error.flatten().fieldErrors);
    process.exit(1);
  }
  
  return result.data;
}

export const env = loadEnv();
