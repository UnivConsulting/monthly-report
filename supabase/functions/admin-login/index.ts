// Supabase Edge Function: admin-login
//
// 흐름:
//   1. 프론트가 GitHub OAuth 콜백 직후 호출
//   2. Supabase JWT 로 유저 확인
//   3. x-github-token 헤더의 GitHub access token 으로
//      GET /user/memberships/orgs/UnivConsulting 조회
//   4. state == "active" 이면 public.admins 에 upsert, 아니면 403
//
// 배포:
//   supabase functions deploy admin-login --no-verify-jwt
//
// 환경 변수:
//   SUPABASE_URL                 (자동)
//   SUPABASE_SERVICE_ROLE_KEY    (자동)
//   REQUIRED_GITHUB_ORG          (선택, 기본값 "UnivConsulting")

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REQUIRED_ORG = Deno.env.get("REQUIRED_GITHUB_ORG") ?? "UnivConsulting";

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-github-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const ghToken = req.headers.get("x-github-token") ?? "";
  if (!authHeader.startsWith("Bearer ") || !ghToken) {
    return json({ error: "missing_auth" }, 401);
  }

  // 1) Supabase JWT 검증
  const userClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: userErr,
  } = await userClient.auth.getUser();
  if (userErr || !user) {
    return json({ error: "invalid_token" }, 401);
  }

  // 2) GitHub org 멤버십 검증
  const ghRes = await fetch(
    `https://api.github.com/user/memberships/orgs/${REQUIRED_ORG}`,
    {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "monthly-report-admin",
      },
    },
  );

  if (ghRes.status === 404 || ghRes.status === 403) {
    return json({ error: "not_org_member", org: REQUIRED_ORG }, 403);
  }
  if (!ghRes.ok) {
    console.error("github_api_error", ghRes.status, await ghRes.text());
    return json({ error: "github_error", status: ghRes.status }, 502);
  }
  const membership = await ghRes.json();
  if (membership?.state !== "active") {
    return json(
      { error: "not_org_member", state: membership?.state ?? null },
      403,
    );
  }

  // 3) admins 테이블에 upsert
  const ghLogin: string | null =
    membership.user?.login ??
    (user.user_metadata?.user_name as string | undefined) ??
    (user.user_metadata?.preferred_username as string | undefined) ??
    null;

  const { error: upsertErr } = await adminClient.from("admins").upsert(
    {
      user_id: user.id,
      github_login: ghLogin,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (upsertErr) {
    console.error("upsert_admin_error", upsertErr);
    return json({ error: "server_error" }, 500);
  }

  return json({ ok: true, github_login: ghLogin });
});
