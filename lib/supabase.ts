"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const DEV_SERVICE_ROLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;

export const IS_DEV_BYPASS =
  process.env.NODE_ENV === "development" && !!DEV_SERVICE_ROLE_KEY;

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!_client) {
    const key = IS_DEV_BYPASS ? DEV_SERVICE_ROLE_KEY! : SUPABASE_ANON_KEY;
    _client = createClient(SUPABASE_URL, key, {
      auth: {
        persistSession: !IS_DEV_BYPASS,
        autoRefreshToken: !IS_DEV_BYPASS,
        detectSessionInUrl: !IS_DEV_BYPASS,
      },
    });
  }
  return _client;
}
