-- ============================================================
-- 유니브컨설팅 월말 리포트 - Supabase 스키마
-- ============================================================
-- Supabase 프로젝트의 SQL Editor에 그대로 붙여 넣어 실행하세요.

-- 비밀번호 해싱 / 검증을 위한 pgcrypto 확장
create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- reports 테이블
-- ------------------------------------------------------------
create table if not exists public.reports (
  report_id     text primary key,                 -- URL ?code= 값
  password_hash text not null,                    -- bcrypt 해시 (pgcrypto)
  student_name  text not null,
  report_title  text not null,
  pdf_path      text not null,                    -- storage 버킷 내 경로
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- updated_at 자동 갱신
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_reports_updated_at on public.reports;
create trigger trg_reports_updated_at
before update on public.reports
for each row execute function public.set_updated_at();

-- RLS 활성화: 정책을 만들지 않음 = anon / authenticated 모두 직접 접근 불가
-- (service-role 키만 직접 접근 가능, 클라이언트는 Edge Function 경유)
alter table public.reports enable row level security;

-- ------------------------------------------------------------
-- 비밀번호 검증 RPC (Edge Function이 service-role로 호출)
-- 결과가 0 행이면 인증 실패 (존재 안 함 / 비번 불일치 구분 안 함 = 정보 누출 방지)
-- ------------------------------------------------------------
create or replace function public.verify_report_password(
  p_report_id text,
  p_password  text
)
returns table (
  student_name text,
  report_title text,
  pdf_path     text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.reports;
begin
  select * into v_row
  from public.reports
  where report_id = p_report_id;

  if not found then
    return;
  end if;

  if v_row.password_hash <> crypt(p_password, v_row.password_hash) then
    return;
  end if;

  return query select v_row.student_name, v_row.report_title, v_row.pdf_path;
end;
$$;

-- ------------------------------------------------------------
-- 리포트 등록/수정 헬퍼 (관리자가 service-role 키로 호출)
-- 호출 예:
--   select public.upsert_report(
--     'R2026-05-홍길동',           -- 리포트ID (URL ?code= 값)
--     'student-password-1234',     -- 평문 비밀번호 (저장 시 자동 해시)
--     '홍길동',
--     '2026년 5월 월말 리포트',
--     '2026/05/홍길동.pdf'         -- reports 버킷 내 객체 경로
--   );
-- ------------------------------------------------------------
create or replace function public.upsert_report(
  p_report_id    text,
  p_password     text,
  p_student_name text,
  p_report_title text,
  p_pdf_path     text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.reports (report_id, password_hash, student_name, report_title, pdf_path)
  values (
    p_report_id,
    crypt(p_password, gen_salt('bf')),
    p_student_name,
    p_report_title,
    p_pdf_path
  )
  on conflict (report_id) do update set
    password_hash = crypt(p_password, gen_salt('bf')),
    student_name  = excluded.student_name,
    report_title  = excluded.report_title,
    pdf_path      = excluded.pdf_path;
end;
$$;

-- anon / authenticated 키로는 함수 호출 불가 (Edge Function = service-role 만 가능)
revoke all on function public.verify_report_password(text, text) from public, anon, authenticated;
revoke all on function public.upsert_report(text, text, text, text, text) from public, anon, authenticated;

-- ============================================================
-- Storage 버킷
-- ============================================================
-- Supabase Studio > Storage 에서 "reports" 이름의 private(공개 X) 버킷을 생성하세요.
-- SQL로도 생성 가능:
insert into storage.buckets (id, name, public)
values ('reports', 'reports', false)
on conflict (id) do nothing;

-- 이 버킷에는 별도 storage policy 를 만들지 않습니다.
-- PDF 접근은 Edge Function 이 service-role 로 발급하는 signed URL 로만 가능합니다.

-- ============================================================
-- 관리자 영역 (GitHub OAuth + UnivConsulting org 멤버)
-- ============================================================

-- 관리자 화이트리스트 (Edge Function admin-login 이 GitHub org 검증 후 upsert)
create table if not exists public.admins (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  github_login text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.admins enable row level security;

-- 본인 행만 SELECT (프론트가 "내가 관리자인지" 확인용)
drop policy if exists admins_self_read on public.admins;
create policy admins_self_read on public.admins
  for select to authenticated
  using (user_id = auth.uid());

-- 현재 로그인 유저가 admin 인지
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admins where user_id = auth.uid()
  );
$$;

grant execute on function public.is_admin() to authenticated;

-- reports 테이블: admin 은 모든 작업 가능 (SELECT 포함)
drop policy if exists reports_admin_all on public.reports;
create policy reports_admin_all on public.reports
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 관리자용 upsert (비번 자동 bcrypt 해시 + admin 권한 강제)
create or replace function public.admin_upsert_report(
  p_report_id    text,
  p_password     text,
  p_student_name text,
  p_report_title text,
  p_pdf_path     text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.reports (report_id, password_hash, student_name, report_title, pdf_path)
  values (
    p_report_id,
    crypt(p_password, gen_salt('bf')),
    p_student_name,
    p_report_title,
    p_pdf_path
  )
  on conflict (report_id) do update set
    password_hash = crypt(p_password, gen_salt('bf')),
    student_name  = excluded.student_name,
    report_title  = excluded.report_title,
    pdf_path      = excluded.pdf_path;
end;
$$;

grant execute on function public.admin_upsert_report(text, text, text, text, text) to authenticated;

-- 비번은 그대로 두고 메타데이터(학생명/제목/PDF경로)만 수정
create or replace function public.admin_update_report_meta(
  p_report_id    text,
  p_student_name text,
  p_report_title text,
  p_pdf_path     text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.reports
  set student_name = p_student_name,
      report_title = p_report_title,
      pdf_path     = p_pdf_path
  where report_id = p_report_id;
end;
$$;

grant execute on function public.admin_update_report_meta(text, text, text, text) to authenticated;

-- ------------------------------------------------------------
-- Storage 정책: admin 은 reports 버킷에 SELECT/INSERT/UPDATE/DELETE 가능
-- ------------------------------------------------------------
drop policy if exists reports_admin_storage_select on storage.objects;
drop policy if exists reports_admin_storage_insert on storage.objects;
drop policy if exists reports_admin_storage_update on storage.objects;
drop policy if exists reports_admin_storage_delete on storage.objects;

create policy reports_admin_storage_select on storage.objects
  for select to authenticated
  using (bucket_id = 'reports' and public.is_admin());

create policy reports_admin_storage_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'reports' and public.is_admin());

create policy reports_admin_storage_update on storage.objects
  for update to authenticated
  using (bucket_id = 'reports' and public.is_admin())
  with check (bucket_id = 'reports' and public.is_admin());

create policy reports_admin_storage_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'reports' and public.is_admin());
