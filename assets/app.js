"use strict";

// ============================================================
// 설정
// ============================================================
const CONFIG = window.APP_CONFIG || {};
const SUPABASE_URL = CONFIG.SUPABASE_URL;
const SUPABASE_ANON_KEY = CONFIG.SUPABASE_ANON_KEY;
const EDGE_ENDPOINT = `${SUPABASE_URL}/functions/v1/get-report`;

// ============================================================
// DOM
// ============================================================
const $ = (id) => document.getElementById(id);
const missingCode = $("missing-code");
const authSection = $("auth-section");
const viewerSection = $("viewer-section");
const authForm = $("auth-form");
const passwordInput = $("password");
const submitBtn = $("submit-btn");
const errorMsg = $("error-msg");
const loading = $("loading");
const pdfFrame = $("pdf-frame");
const downloadLink = $("download-link");
const studentNameEl = $("student-name");
const reportTitleEl = $("report-title");

const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");
const setError = (msg) => {
  errorMsg.textContent = msg;
  show(errorMsg);
};
const clearError = () => {
  errorMsg.textContent = "";
  hide(errorMsg);
};
const setLoading = (on) => {
  if (on) {
    show(loading);
    submitBtn.disabled = true;
  } else {
    hide(loading);
    submitBtn.disabled = false;
  }
};

// ============================================================
// URL 파라미터
// ============================================================
const params = new URLSearchParams(window.location.search);
const reportId = (params.get("code") || "").trim();

if (!reportId) {
  show(missingCode);
} else {
  show(authSection);
  passwordInput.focus();
}

// ============================================================
// 인증 + PDF 로드
// ============================================================
authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError();

  const password = passwordInput.value;
  if (!password) {
    setError("비밀번호를 입력해 주세요.");
    return;
  }
  if (!SUPABASE_URL || SUPABASE_URL.includes("YOUR-PROJECT-REF")) {
    setError("서비스 설정이 완료되지 않았습니다. 관리자에게 문의해 주세요.");
    return;
  }

  setLoading(true);
  try {
    const res = await fetch(EDGE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ report_id: reportId, password }),
    });

    if (res.status === 401) {
      setError("리포트ID 또는 비밀번호가 올바르지 않습니다.");
      passwordInput.select();
      return;
    }
    if (!res.ok) {
      setError("일시적인 오류가 발생했어요. 잠시 후 다시 시도해 주세요.");
      return;
    }

    const data = await res.json();
    if (!data?.pdf_url) {
      setError("리포트를 불러오지 못했습니다.");
      return;
    }
    renderViewer(data);
  } catch (err) {
    console.error(err);
    setError("네트워크 오류가 발생했어요. 연결 상태를 확인해 주세요.");
  } finally {
    setLoading(false);
  }
});

function renderViewer({ student_name, report_title, pdf_url }) {
  hide(authSection);
  studentNameEl.textContent = student_name ? `${student_name} 학생` : "";
  reportTitleEl.textContent = report_title || "월말 리포트";
  document.title = report_title
    ? `${report_title} · 유니브컨설팅`
    : "유니브컨설팅 월말 리포트";
  pdfFrame.src = pdf_url;
  downloadLink.href = pdf_url;
  show(viewerSection);
}
