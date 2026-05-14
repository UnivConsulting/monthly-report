// Supabase Edge Function: get-report
// 클라이언트가 보낸 { report_id, password } 를 검증하고,
// 일치하면 PDF signed URL + 리포트 메타데이터를 돌려준다.
//
// 배포:
//   supabase functions deploy get-report --no-verify-jwt
//
// 환경 변수 (Supabase가 자동 주입):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "reports";
const SIGNED_URL_TTL_SECONDS = 600; // 10분

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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

  let payload: { report_id?: string; password?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const reportId = (payload.report_id ?? "").trim();
  const password = payload.password ?? "";
  if (!reportId || !password) {
    return json({ error: "missing_params" }, 400);
  }

  const { data, error } = await supabase.rpc("verify_report_password", {
    p_report_id: reportId,
    p_password: password,
  });

  if (error) {
    console.error("rpc_error", error);
    return json({ error: "server_error" }, 500);
  }
  if (!data || data.length === 0) {
    return json({ error: "invalid_credentials" }, 401);
  }

  const row = data[0] as {
    student_name: string;
    report_title: string;
    pdf_path: string;
  };

  const { data: urlData, error: urlError } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(row.pdf_path, SIGNED_URL_TTL_SECONDS);

  if (urlError || !urlData?.signedUrl) {
    console.error("signed_url_error", urlError);
    return json({ error: "server_error" }, 500);
  }

  return json({
    student_name: row.student_name,
    report_title: row.report_title,
    pdf_url: urlData.signedUrl,
    expires_in: SIGNED_URL_TTL_SECONDS,
  });
});
