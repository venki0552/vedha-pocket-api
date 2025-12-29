import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Types for Supabase client options
export interface SupabaseClientOptions {
  supabaseUrl: string;
  supabaseKey: string;
  isServiceRole?: boolean;
}

// Create a Supabase client
export function createSupabaseClient(options: SupabaseClientOptions): SupabaseClient {
  const { supabaseUrl, supabaseKey, isServiceRole = false } = options;
  
  return createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: !isServiceRole,
      persistSession: !isServiceRole,
    },
    db: {
      schema: 'public',
    },
  });
}

// Create a service role client (for worker/API)
export function createServiceClient(supabaseUrl: string, serviceRoleKey: string): SupabaseClient {
  return createSupabaseClient({
    supabaseUrl,
    supabaseKey: serviceRoleKey,
    isServiceRole: true,
  });
}

// Create a client with user's JWT
export function createUserClient(
  supabaseUrl: string,
  supabaseAnonKey: string,
  accessToken?: string
): SupabaseClient {
  const client = createSupabaseClient({
    supabaseUrl,
    supabaseKey: supabaseAnonKey,
    isServiceRole: false,
  });

  // If access token provided, set it for the session
  if (accessToken) {
    client.auth.setSession({
      access_token: accessToken,
      refresh_token: '',
    });
  }

  return client;
}

export type { SupabaseClient };
