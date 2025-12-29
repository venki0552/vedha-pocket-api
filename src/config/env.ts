import { z } from 'zod';

const envSchema = z.object({
  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Redis
  REDIS_URL: z.string().min(1),

  // OpenRouter
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  OPENROUTER_EMBED_MODEL: z.string().default('openai/text-embedding-3-large'),
  OPENROUTER_CHAT_MODEL: z.string().default('google/gemma-3-27b-it:free'),
  OPENROUTER_FALLBACK_CHAT_MODEL: z.string().default('openai/gpt-oss-120b:free'),

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
