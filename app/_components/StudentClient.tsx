"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/supabase";

type ReportData = {
  student_name?: string;
  report_title?: string;
  pdf_url: string;
};

export default function StudentClient() {
  const searchParams = useSearchParams();
  const reportId = (searchParams.get("code") || "").trim();

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ReportData | null>(null);

  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (reportId) passwordRef.current?.focus();
  }, [reportId]);

  useEffect(() => {
    if (data?.report_title) {
      document.title = `${data.report_title} · 유니브컨설팅`;
    }
  }, [data]);

  if (!reportId) {
    return (
      <>
        <header className="hero">
          <h1>유니브컨설팅 리포트</h1>
        </header>
        <main className="container">
          <section className="card" aria-live="polite">
            <h2>잘못된 접근입니다</h2>
            <p>리포트 링크에 코드가 포함되어 있어야 합니다.</p>
            <p className="muted">안내드린 정확한 링크로 다시 접속해 주세요.</p>
          </section>
        </main>
      </>
    );
  }

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

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
      const res = await fetch(`${SUPABASE_URL}/functions/v1/get-report`, {
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
        passwordRef.current?.select();
        return;
      }
      if (!res.ok) {
        setError("일시적인 오류가 발생했어요. 잠시 후 다시 시도해 주세요.");
        return;
      }

      const json = (await res.json()) as Partial<ReportData>;
      if (!json?.pdf_url) {
        setError("리포트를 불러오지 못했습니다.");
        return;
      }
      setData({
        student_name: json.student_name,
        report_title: json.report_title,
        pdf_url: json.pdf_url,
      });
    } catch (err) {
      console.error(err);
      setError("네트워크 오류가 발생했어요. 연결 상태를 확인해 주세요.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {!data && (
        <header className="hero">
          <h1>유니브컨설팅 리포트</h1>
        </header>
      )}
      <main className="container">
        {!data && (
          <section className="card">
            <h2>접속 비밀번호</h2>
            <p className="muted">리포트와 함께 전달드린 비밀번호를 입력해 주세요.</p>

            <form onSubmit={onSubmit} autoComplete="off" noValidate>
              <label className="sr-only" htmlFor="password">
                비밀번호
              </label>
              <input
                ref={passwordRef}
                id="password"
                name="password"
                type="password"
                required
                autoComplete="one-time-code"
                placeholder="비밀번호"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-describedby="error-msg"
              />
              <button type="submit" disabled={loading}>
                리포트 열기
              </button>
              {error && (
                <p id="error-msg" className="error" role="alert">
                  {error}
                </p>
              )}
            </form>
          </section>
        )}

        {data && (
          <section className="viewer" aria-live="polite">
            <div className="viewer-header">
              <div className="viewer-meta">
                <p className="muted small">
                  {data.student_name ? `${data.student_name} 학생` : ""}
                </p>
                <h2>{data.report_title || "월말 리포트"}</h2>
              </div>
              <a
                href={data.pdf_url}
                target="_blank"
                rel="noopener"
                className="btn-secondary"
              >
                새 창에서 열기
              </a>
            </div>
            <div className="viewer-frame-wrap">
              <iframe
                src={data.pdf_url}
                title="리포트 PDF"
                referrerPolicy="no-referrer"
              />
            </div>
          </section>
        )}

        {loading && (
          <div className="loading" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>확인 중…</span>
          </div>
        )}
      </main>
    </>
  );
}
