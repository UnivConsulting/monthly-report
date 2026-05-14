"use strict";

// ============================================================
// Supabase 클라이언트
// ============================================================
const CONFIG = window.APP_CONFIG || {};
const SUPABASE_URL = CONFIG.SUPABASE_URL;
const SUPABASE_ANON_KEY = CONFIG.SUPABASE_ANON_KEY;
const ADMIN_LOGIN_ENDPOINT = `${SUPABASE_URL}/functions/v1/admin-login`;
const BUCKET = "reports";
const REDIRECT_TO = `${window.location.origin}/admin.html`;

if (!window.supabase || !window.supabase.createClient) {
  alert("Supabase 라이브러리를 불러오지 못했습니다. 페이지를 새로고침해 주세요.");
}
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

// ============================================================
// DOM
// ============================================================
const $ = (id) => document.getElementById(id);
const bootSection = $("boot-section");
const loginSection = $("login-section");
const deniedSection = $("denied-section");
const adminSection = $("admin-section");
const errorBanner = $("error-banner");
const userBadge = $("user-badge");
const logoutBtn = $("logout-btn");
const loginBtn = $("login-btn");
const deniedLogoutBtn = $("denied-logout-btn");
const refreshBtn = $("refresh-btn");
const reportForm = $("report-form");
const formSubmit = $("form-submit");
const formStatus = $("form-status");
const reportsList = $("reports-list");

const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");
const showOnly = (sectionToShow) => {
  for (const s of [bootSection, loginSection, deniedSection, adminSection]) {
    if (s === sectionToShow) show(s); else hide(s);
  }
};
const showError = (msg) => {
  errorBanner.textContent = msg;
  show(errorBanner);
};
const clearError = () => {
  errorBanner.textContent = "";
  hide(errorBanner);
};

// ============================================================
// 로그인 / 로그아웃 / 부트스트랩
// ============================================================
loginBtn.addEventListener("click", async () => {
  clearError();
  const { error } = await sb.auth.signInWithOAuth({
    provider: "github",
    options: {
      scopes: "read:org",
      redirectTo: REDIRECT_TO,
    },
  });
  if (error) showError("로그인 시작 중 오류: " + error.message);
});

const doLogout = async () => {
  await sb.auth.signOut();
  window.location.assign("/admin.html");
};
logoutBtn.addEventListener("click", doLogout);
deniedLogoutBtn.addEventListener("click", doLogout);
refreshBtn.addEventListener("click", () => loadReports());

async function bootstrap() {
  clearError();
  showOnly(bootSection);

  const {
    data: { session },
  } = await sb.auth.getSession();

  if (!session) {
    showOnly(loginSection);
    return;
  }

  // OAuth 콜백 직후라면 provider_token 이 있다 → 매 로그인마다 GitHub org 재검증
  if (session.provider_token) {
    try {
      const res = await fetch(ADMIN_LOGIN_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
          apikey: SUPABASE_ANON_KEY,
          "x-github-token": session.provider_token,
        },
      });
      if (res.status === 403) {
        await sb.auth.signOut();
        showOnly(deniedSection);
        return;
      }
      if (!res.ok) {
        showError("관리자 검증에 실패했습니다. 잠시 후 다시 시도해 주세요.");
        showOnly(loginSection);
        return;
      }
    } catch (err) {
      console.error(err);
      showError("네트워크 오류가 발생했습니다.");
      showOnly(loginSection);
      return;
    }
  }

  // admins 테이블 self-read 로 관리자 여부 확인
  const { data: adminRow, error: adminErr } = await sb
    .from("admins")
    .select("user_id, github_login")
    .eq("user_id", session.user.id)
    .maybeSingle();

  if (adminErr) {
    console.error(adminErr);
    showError("관리자 정보를 확인하지 못했습니다: " + adminErr.message);
    showOnly(loginSection);
    return;
  }
  if (!adminRow) {
    showOnly(deniedSection);
    return;
  }

  const handle =
    adminRow.github_login ||
    session.user.user_metadata?.user_name ||
    session.user.email ||
    "admin";
  userBadge.textContent = `@${handle}`;
  show(userBadge);
  show(logoutBtn);
  showOnly(adminSection);

  await loadReports();
}

// ============================================================
// 리포트 목록
// ============================================================
async function loadReports() {
  reportsList.innerHTML =
    '<tr><td colspan="5" class="muted center">불러오는 중…</td></tr>';

  const { data, error } = await sb
    .from("reports")
    .select("report_id, student_name, report_title, pdf_path, created_at, updated_at")
    .order("updated_at", { ascending: false });

  if (error) {
    reportsList.innerHTML = `<tr><td colspan="5" class="error center">${escapeHtml(
      "목록 조회 실패: " + error.message,
    )}</td></tr>`;
    return;
  }
  renderReports(data || []);
}

function renderReports(rows) {
  if (rows.length === 0) {
    reportsList.innerHTML =
      '<tr><td colspan="5" class="muted center">등록된 리포트가 없습니다.</td></tr>';
    return;
  }
  reportsList.innerHTML = rows
    .map((r) => {
      const id = escapeHtml(r.report_id);
      const path = escapeHtml(r.pdf_path);
      const ts = formatDate(r.updated_at || r.created_at);
      return `<tr>
        <td><code>${id}</code></td>
        <td>${escapeHtml(r.student_name)}</td>
        <td>${escapeHtml(r.report_title)}</td>
        <td class="muted small">${escapeHtml(ts)}</td>
        <td class="row-actions">
          <button type="button" class="btn-text" data-action="copy" data-id="${id}">링크 복사</button>
          <button type="button" class="btn-text danger" data-action="delete" data-id="${id}" data-path="${path}">삭제</button>
        </td>
      </tr>`;
    })
    .join("");
}

reportsList.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;

  if (action === "copy") {
    const url = `${window.location.origin}/?code=${encodeURIComponent(id)}`;
    try {
      await navigator.clipboard.writeText(url);
      const prev = btn.textContent;
      btn.textContent = "복사됨!";
      setTimeout(() => (btn.textContent = prev), 1500);
    } catch {
      prompt("아래 링크를 복사하세요:", url);
    }
    return;
  }

  if (action === "delete") {
    if (!confirm(`'${id}' 리포트를 삭제할까요? PDF 파일도 함께 삭제됩니다.`)) return;
    btn.disabled = true;
    const path = btn.dataset.path;
    const { error: delErr } = await sb.from("reports").delete().eq("report_id", id);
    if (delErr) {
      showError("삭제 실패: " + delErr.message);
      btn.disabled = false;
      return;
    }
    if (path) {
      const { error: rmErr } = await sb.storage.from(BUCKET).remove([path]);
      if (rmErr) console.warn("storage remove warning:", rmErr.message);
    }
    await loadReports();
  }
});

// ============================================================
// 등록 / 업데이트 폼
// ============================================================
reportForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError();
  formStatus.textContent = "";

  const reportId = $("rf-report-id").value.trim();
  const password = $("rf-password").value;
  const studentName = $("rf-student-name").value.trim();
  const reportTitle = $("rf-report-title").value.trim();
  const file = $("rf-pdf").files[0];

  if (!reportId || !password || !studentName || !reportTitle || !file) {
    showError("모든 필드를 입력해 주세요.");
    return;
  }
  if (file.type !== "application/pdf") {
    showError("PDF 파일만 업로드할 수 있습니다.");
    return;
  }

  // Storage 경로: YYYY/MM/<safe-report-id>.pdf
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const safeId = reportId.replace(/[^\w\-가-힣]/g, "_");
  const pdfPath = `${yyyy}/${mm}/${safeId}.pdf`;

  formSubmit.disabled = true;
  try {
    formStatus.textContent = "PDF 업로드 중…";
    const { error: upErr } = await sb.storage.from(BUCKET).upload(pdfPath, file, {
      contentType: "application/pdf",
      upsert: true,
      cacheControl: "no-store",
    });
    if (upErr) {
      showError("PDF 업로드 실패: " + upErr.message);
      return;
    }

    formStatus.textContent = "리포트 정보 저장 중…";
    const { error: rpcErr } = await sb.rpc("admin_upsert_report", {
      p_report_id: reportId,
      p_password: password,
      p_student_name: studentName,
      p_report_title: reportTitle,
      p_pdf_path: pdfPath,
    });
    if (rpcErr) {
      showError("저장 실패: " + rpcErr.message);
      return;
    }

    formStatus.textContent = "저장 완료";
    reportForm.reset();
    setTimeout(() => (formStatus.textContent = ""), 2000);
    await loadReports();
  } finally {
    formSubmit.disabled = false;
  }
});

// ============================================================
// 유틸
// ============================================================
function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

bootstrap();
