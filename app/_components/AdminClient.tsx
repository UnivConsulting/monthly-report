"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabase, SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/supabase";

const BUCKET = "reports";
const ADMIN_LOGIN_ENDPOINT = `${SUPABASE_URL}/functions/v1/admin-login`;

type View = "boot" | "login" | "denied" | "admin";

type ReportRow = {
  report_id: string;
  student_name: string;
  report_title: string;
  pdf_path: string;
  created_at: string | null;
  updated_at: string | null;
};

export default function AdminClient() {
  const [view, setView] = useState<View>("boot");
  const [error, setError] = useState<string | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const [reports, setReports] = useState<ReportRow[] | null>(null);
  const [reportsError, setReportsError] = useState<string | null>(null);

  const [reportId, setReportId] = useState("");
  const [password, setPassword] = useState("");
  const [studentName, setStudentName] = useState("");
  const [reportTitle, setReportTitle] = useState("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formStatus, setFormStatus] = useState("");
  const pdfInputRef = useRef<HTMLInputElement>(null);

  const resetForm = () => {
    setReportId("");
    setPassword("");
    setStudentName("");
    setReportTitle("");
    setPdfFile(null);
    if (pdfInputRef.current) pdfInputRef.current.value = "";
    setFormStatus("");
  };

  const loadReports = useCallback(async () => {
    setReports(null);
    setReportsError(null);
    const sb = getSupabase();
    const { data, error } = await sb
      .from("reports")
      .select(
        "report_id, student_name, report_title, pdf_path, created_at, updated_at",
      )
      .order("updated_at", { ascending: false });
    if (error) {
      setReportsError("목록 조회 실패: " + error.message);
      setReports([]);
      return;
    }
    setReports((data || []) as ReportRow[]);
  }, []);

  const bootstrap = useCallback(async () => {
    setError(null);
    setView("boot");

    const sb = getSupabase();
    const {
      data: { session },
    } = await sb.auth.getSession();

    if (!session) {
      setView("login");
      return;
    }

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
          setView("denied");
          return;
        }
        if (!res.ok) {
          setError("관리자 검증에 실패했습니다. 잠시 후 다시 시도해 주세요.");
          setView("login");
          return;
        }
      } catch (err) {
        console.error(err);
        setError("네트워크 오류가 발생했습니다.");
        setView("login");
        return;
      }
    }

    const { data: adminRow, error: adminErr } = await sb
      .from("admins")
      .select("user_id, github_login")
      .eq("user_id", session.user.id)
      .maybeSingle();

    if (adminErr) {
      console.error(adminErr);
      setError("관리자 정보를 확인하지 못했습니다: " + adminErr.message);
      setView("login");
      return;
    }
    if (!adminRow) {
      setView("denied");
      return;
    }

    const userMeta = session.user.user_metadata as { user_name?: string } | null;
    setHandle(
      adminRow.github_login || userMeta?.user_name || session.user.email || "admin",
    );
    setView("admin");
    void loadReports();
  }, [loadReports]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const onLogin = async () => {
    setError(null);
    const sb = getSupabase();
    const { error } = await sb.auth.signInWithOAuth({
      provider: "github",
      options: {
        scopes: "read:org",
        redirectTo: `${window.location.origin}/admin/`,
      },
    });
    if (error) setError("로그인 시작 중 오류: " + error.message);
  };

  const onLogout = async () => {
    const sb = getSupabase();
    await sb.auth.signOut();
    window.location.assign("/admin/");
  };

  const onCopyLink = async (id: string, btn: HTMLButtonElement) => {
    const url = `${window.location.origin}/?code=${encodeURIComponent(id)}`;
    try {
      await navigator.clipboard.writeText(url);
      const prev = btn.textContent;
      btn.textContent = "복사됨!";
      setTimeout(() => {
        btn.textContent = prev;
      }, 1500);
    } catch {
      window.prompt("아래 링크를 복사하세요:", url);
    }
  };

  const onDelete = async (id: string, path: string) => {
    if (!window.confirm(`'${id}' 리포트를 삭제할까요? PDF 파일도 함께 삭제됩니다.`))
      return;
    const sb = getSupabase();
    const { error: delErr } = await sb.from("reports").delete().eq("report_id", id);
    if (delErr) {
      setError("삭제 실패: " + delErr.message);
      return;
    }
    if (path) {
      const { error: rmErr } = await sb.storage.from(BUCKET).remove([path]);
      if (rmErr) console.warn("storage remove warning:", rmErr.message);
    }
    void loadReports();
  };

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setFormStatus("");

    const id = reportId.trim();
    const sName = studentName.trim();
    const rTitle = reportTitle.trim();

    if (!id || !password || !sName || !rTitle || !pdfFile) {
      setError("모든 필드를 입력해 주세요.");
      return;
    }
    if (pdfFile.type !== "application/pdf") {
      setError("PDF 파일만 업로드할 수 있습니다.");
      return;
    }

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const safeId = id.replace(/[^\w\-가-힣]/g, "_");
    const pdfPath = `${yyyy}/${mm}/${safeId}.pdf`;

    setSubmitting(true);
    try {
      const sb = getSupabase();
      setFormStatus("PDF 업로드 중…");
      const { error: upErr } = await sb.storage.from(BUCKET).upload(pdfPath, pdfFile, {
        contentType: "application/pdf",
        upsert: true,
        cacheControl: "no-store",
      });
      if (upErr) {
        setError("PDF 업로드 실패: " + upErr.message);
        return;
      }

      setFormStatus("리포트 정보 저장 중…");
      const { error: rpcErr } = await sb.rpc("admin_upsert_report", {
        p_report_id: id,
        p_password: password,
        p_student_name: sName,
        p_report_title: rTitle,
        p_pdf_path: pdfPath,
      });
      if (rpcErr) {
        setError("저장 실패: " + rpcErr.message);
        return;
      }

      resetForm();
      setFormStatus("저장 완료");
      setTimeout(() => setFormStatus(""), 2000);
      void loadReports();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="container container-wide">
      <header className="admin-topbar">
        <h1>리포트 관리</h1>
        <div className="topbar-right">
          {view === "admin" && handle && (
            <>
              <span className="user-badge">@{handle}</span>
              <button type="button" className="btn-secondary" onClick={onLogout}>
                로그아웃
              </button>
            </>
          )}
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}

      {view === "boot" && (
        <section className="card center-card">
          <span className="spinner" aria-hidden="true" />
          <p className="muted">확인 중…</p>
        </section>
      )}

      {view === "login" && (
        <section className="card center-card">
          <h2>관리자 로그인</h2>
          <p className="muted">
            GitHub 계정으로 로그인해 주세요.
            <br />
            <strong>UnivConsulting</strong> 오가니제이션 활성 멤버만 접근할 수 있습니다.
          </p>
          <button type="button" className="btn-github" onClick={onLogin}>
            <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
            </svg>
            GitHub으로 로그인
          </button>
        </section>
      )}

      {view === "denied" && (
        <section className="card center-card">
          <h2>접근 권한이 없습니다</h2>
          <p className="muted">
            UnivConsulting 오가니제이션의 활성 멤버 계정으로만 접근할 수 있습니다.
          </p>
          <p className="muted small">
            조직 멤버라면 GitHub 설정 → Applications 에서 OAuth 앱에 조직 접근을 승인했는지 확인해 주세요.
          </p>
          <button type="button" className="btn-secondary" onClick={onLogout}>
            다른 계정으로 로그인
          </button>
        </section>
      )}

      {view === "admin" && (
        <section>
          <div className="card">
            <h2>리포트 등록 / 수정</h2>
            <p className="muted small">
              동일한 리포트ID로 등록하면 기존 리포트가 덮어쓰기 됩니다.
            </p>

            <form onSubmit={onSubmit} className="report-form" autoComplete="off">
              <div className="grid-2">
                <div className="field">
                  <label htmlFor="rf-report-id">리포트ID</label>
                  <input
                    id="rf-report-id"
                    type="text"
                    required
                    placeholder="예: 202605-honggildong"
                    value={reportId}
                    onChange={(e) => setReportId(e.target.value)}
                  />
                  <small className="muted">
                    URL <code>?code=</code> 값. 영문/숫자/하이픈 권장.
                  </small>
                </div>
                <div className="field">
                  <label htmlFor="rf-password">접속 비밀번호</label>
                  <input
                    id="rf-password"
                    type="text"
                    required
                    placeholder="학생에게 전달할 비밀번호"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="rf-student-name">학생명</label>
                  <input
                    id="rf-student-name"
                    type="text"
                    required
                    placeholder="홍길동"
                    value={studentName}
                    onChange={(e) => setStudentName(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="rf-report-title">리포트 제목</label>
                  <input
                    id="rf-report-title"
                    type="text"
                    required
                    placeholder="2026년 5월 월말 리포트"
                    value={reportTitle}
                    onChange={(e) => setReportTitle(e.target.value)}
                  />
                </div>
              </div>

              <div className="field">
                <label htmlFor="rf-pdf">PDF 파일</label>
                <input
                  ref={pdfInputRef}
                  id="rf-pdf"
                  type="file"
                  accept="application/pdf"
                  required
                  onChange={(e) => setPdfFile(e.target.files?.[0] ?? null)}
                />
                <small className="muted">
                  최대 50MB. 같은 리포트ID로 재업로드하면 PDF도 덮어쓰기됩니다.
                </small>
              </div>

              <div className="form-actions">
                <button type="submit" disabled={submitting}>
                  등록
                </button>
                <button type="reset" className="btn-secondary" onClick={resetForm}>
                  초기화
                </button>
                <span className="muted small">{formStatus}</span>
              </div>
            </form>
          </div>

          <div className="card">
            <div className="card-header">
              <h2>등록된 리포트</h2>
              <button type="button" className="btn-text" onClick={() => loadReports()}>
                새로고침
              </button>
            </div>
            <div className="table-wrap">
              <table className="reports-table">
                <thead>
                  <tr>
                    <th>리포트ID</th>
                    <th>학생명</th>
                    <th>제목</th>
                    <th>최근 수정</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {reports === null && (
                    <tr>
                      <td colSpan={5} className="muted center">
                        불러오는 중…
                      </td>
                    </tr>
                  )}
                  {reportsError && (
                    <tr>
                      <td colSpan={5} className="error center">
                        {reportsError}
                      </td>
                    </tr>
                  )}
                  {reports !== null && !reportsError && reports.length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted center">
                        등록된 리포트가 없습니다.
                      </td>
                    </tr>
                  )}
                  {reports?.map((r) => (
                    <tr key={r.report_id}>
                      <td>
                        <code>{r.report_id}</code>
                      </td>
                      <td>{r.student_name}</td>
                      <td>{r.report_title}</td>
                      <td className="muted small">
                        {formatDate(r.updated_at || r.created_at)}
                      </td>
                      <td className="row-actions">
                        <button
                          type="button"
                          className="btn-text"
                          onClick={(e) => onCopyLink(r.report_id, e.currentTarget)}
                        >
                          링크 복사
                        </button>
                        <button
                          type="button"
                          className="btn-text danger"
                          onClick={() => onDelete(r.report_id, r.pdf_path)}
                        >
                          삭제
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}

function formatDate(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
