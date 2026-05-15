# monthly-report

유니브컨설팅 월말 리포트 배포 페이지.

`report.univconsulting.kr/?code=<리포트ID>` 로 접속하면 비밀번호를 묻고,
일치할 때만 Supabase Storage 에 보관된 PDF 를 signed URL 로 보여줍니다.

## 구조

```
.
├── app/
│   ├── layout.tsx              # 공통 레이아웃 + CSP meta + 폰트
│   ├── page.tsx                # 학생 페이지 (Suspense 래퍼)
│   ├── admin/
│   │   └── page.tsx            # 관리자 페이지 진입
│   ├── _components/
│   │   ├── StudentClient.tsx   # 학생용 비번 입력 + PDF 뷰어
│   │   └── AdminClient.tsx     # 관리자 페이지 클라이언트 로직
│   └── globals.css             # 디자인 시스템 (네이비/골드/크림)
├── lib/
│   └── supabase.ts             # Supabase 클라이언트 (싱글톤)
├── public/
│   ├── CNAME                   # GitHub Pages 커스텀 도메인
│   └── .nojekyll               # Jekyll 처리 비활성화
├── .env                        # NEXT_PUBLIC_SUPABASE_URL / ANON_KEY (공개 안전)
├── .github/workflows/deploy.yml # main push → Pages 자동 배포
├── next.config.mjs             # output: 'export', trailingSlash: true
└── supabase/
    ├── schema.sql              # reports/admins 테이블 + RPC + RLS
    ├── config.toml             # Supabase CLI 설정
    └── functions/
        ├── get-report/
        │   └── index.ts        # 학생용: 비번 검증 + signed URL 발급
        └── admin-login/
            └── index.ts        # 관리자용: GitHub org 멤버십 검증
```

Next.js 15 App Router · static export(`output: 'export'`) · pnpm.
백엔드(Supabase)는 그대로, 프론트만 Next.js 로 변환. 산출물은 정적 HTML/JS 라
GitHub Pages 가 그대로 서빙합니다.

## 동작 흐름

### 학생 (열람)
1. `?code=<리포트ID>` 로 접속 → 비밀번호 입력
2. 프론트가 Edge Function `get-report` 호출
3. Edge Function (service-role) 이 `verify_report_password(report_id, password)` RPC 실행
   - 테이블의 `password_hash` 와 `crypt(password, password_hash)` 비교 (pgcrypto / bcrypt)
4. 일치 시 `reports` 버킷의 PDF 에 대해 signed URL(10분) 발급
5. 학생명·리포트제목·signed URL 응답 → `<iframe>` 으로 표시

`reports` 테이블은 anon 정책이 없어 직접 조회 불가. PDF 버킷도 private.

### 관리자 (등록 / 수정 / 삭제)
1. `/admin.html` → "GitHub으로 로그인" → Supabase Auth (`read:org` scope) OAuth
2. 콜백 후 프론트가 Edge Function `admin-login` 호출 (Supabase JWT + `x-github-token`)
3. Edge Function 이 GitHub `/user/memberships/orgs/UnivConsulting` 조회 →
   `state == "active"` 이면 `public.admins` 에 user_id upsert, 아니면 403
4. 이후 RLS 정책 `is_admin()` 으로 admin 만 `reports` 테이블 / Storage 버킷에 CRUD
5. 폼 제출 시 PDF 를 Storage 에 직접 업로드(`upsert: true`) +
   `admin_upsert_report` RPC 호출 (RPC 내부에서 bcrypt 해시로 저장)

## 1) Supabase 세팅

### 1-1. 프로젝트 준비
- Supabase 콘솔에서 새 프로젝트 생성
- **Project URL** 과 **anon public key** 메모 (프론트 `assets/config.js` 에 사용)
- **service_role key** 메모 (Edge Function 배포 시 자동 주입되므로 별도 입력 불필요)

### 1-2. 스키마 실행
Supabase Studio > SQL Editor 에 [`supabase/schema.sql`](supabase/schema.sql) 전체를 붙여넣고 실행.

다음이 만들어집니다:
- `public.reports` 테이블 (report_id PK, password_hash, student_name, report_title, pdf_path)
- `public.admins` 테이블 (user_id PK → auth.users, github_login)
- 학생용 RPC `verify_report_password(report_id, password)` — 일치 시 행 반환
- 관리자용 RPC `admin_upsert_report(...)` / `admin_update_report_meta(...)` — admin 만 실행
- 헬퍼 `is_admin()` + RLS 정책 (reports 테이블 / storage.objects 의 reports 버킷)
- Storage `reports` 버킷 (private)
- `reports` 에 대한 anon 직접 접근 차단, 학생 PDF 는 signed URL 로만 접근

### 1-3. GitHub OAuth 프로바이더 활성화 (관리자 로그인용)

1. GitHub > Settings > Developer settings > **OAuth Apps** > New OAuth App
   - Application name: `UnivConsulting Monthly Report Admin`
   - Homepage URL: `https://report.univconsulting.kr`
   - **Authorization callback URL**: `https://<YOUR-PROJECT-REF>.supabase.co/auth/v1/callback`
   - Client ID / Client secret 메모
2. Supabase Studio > **Authentication** > Providers > **GitHub**
   - Enable, Client ID / Secret 입력
   - **Scopes**: `read:org` (조직 멤버십 조회용)
   - Redirect URL 은 자동으로 `<project>.supabase.co/auth/v1/callback` 가 들어있음
3. Supabase Studio > Authentication > **URL Configuration**
   - Site URL: `https://report.univconsulting.kr`
   - Redirect URLs 에 `https://report.univconsulting.kr/admin.html` 추가
   - 로컬 테스트할 거면 `http://localhost:5173/admin.html` 등도 추가

> 조직 멤버 본인이 GitHub 설정 → Applications → Authorized OAuth Apps 에서
> 해당 OAuth 앱에 **UnivConsulting** 조직 접근을 명시적으로 승인해야 `/user/memberships/orgs/...` 조회가 통과됩니다.
> 조직 owner 가 미리 third-party app access 정책을 풀어두면 매끄럽습니다.

### 1-4. Edge Function 배포
[Supabase CLI](https://supabase.com/docs/guides/cli) 가 필요합니다.

```bash
# 처음 한 번
supabase login
supabase link --project-ref <YOUR-PROJECT-REF>

# 배포 (두 함수 모두 --no-verify-jwt: 함수 내부에서 직접 검증)
supabase functions deploy get-report   --no-verify-jwt
supabase functions deploy admin-login  --no-verify-jwt
```

(선택) 조직 이름을 바꾸고 싶으면:
```bash
supabase secrets set REQUIRED_GITHUB_ORG=YourOrgName
```

### 1-5. 리포트 등록
**관리자 페이지에서 등록 (권장):**

`https://report.univconsulting.kr/admin.html` 로 접속 → GitHub 로그인 → 폼 입력 + PDF 업로드.
UnivConsulting 조직 활성 멤버만 통과합니다.

**SQL 로 직접 등록 (백업용):**
```sql
select public.upsert_report(
  '202605-honggildong',        -- 리포트ID (?code= 값)
  'student-password-1234',     -- 평문 비밀번호 (자동 bcrypt 해시)
  '홍길동',                    -- 학생명
  '2026년 5월 월말 리포트',    -- 리포트 제목
  '2026/05/honggildong.pdf'    -- reports 버킷 내 객체 경로
);
```
SQL 로 등록할 경우 PDF 는 Storage > `reports` 버킷에 같은 경로로 직접 업로드.

## 2) 프론트엔드 (Next.js 정적 export → GitHub Pages)

### 2-1. 로컬 개발
[`.env.example`](.env.example) 을 복사해 `.env.local` 을 만들고 값을 채우세요.

```bash
cp .env.example .env.local
# 편집 후
pnpm install
pnpm dev          # http://localhost:3000
```

`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` 두 값만 있으면 됩니다
(공개되어도 안전한 anon 키). 진짜 비밀(service_role 키)은 Edge Function 환경에만
존재하며 브라우저에는 절대 들어가지 않습니다.

### 2-2. 빌드
```bash
pnpm build        # out/ 디렉토리에 정적 HTML/JS 생성
```

`next.config.mjs` 의 `output: 'export'` + `trailingSlash: true` 로
GitHub Pages 가 잘 서빙하는 정적 산출물이 만들어집니다
(`/` → `index.html`, `/admin/` → `admin/index.html`).

### 2-3. 배포 (자동)
`main` 브랜치에 push 하면 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
가 자동으로 빌드 → Pages 에 업로드합니다.

```bash
git push origin main
```

### 2-4. GitHub 저장소 설정 (한 번만)

**Pages 활성화**

1. GitHub 저장소 > **Settings** > **Pages**
2. **Source**: `GitHub Actions` 선택 (워크플로 기반 배포)
3. **Custom domain**: `report.univconsulting.kr` 입력 → **Save**
   ([`public/CNAME`](public/CNAME) 이 빌드 산출물에 같이 들어가므로 GitHub 가 자동 인식)
4. DNS 가 잡힌 뒤 **Enforce HTTPS** 체크 (TLS 인증서 자동 발급, 최대 1시간)

**Actions Secrets 등록** (빌드 시 환경변수 주입)

`Settings` > **Secrets and variables** > **Actions** > `New repository secret` 으로
다음 두 개를 등록:

- `NEXT_PUBLIC_SUPABASE_URL` — `.env.local` 의 동일 값
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — `.env.local` 의 동일 값

(anon 키는 공개되어도 안전하지만, .env 가 깃에 올라가지 않으므로 CI 가 빌드할 때 주입해야 합니다.)

### 2-5. DNS 설정
`univconsulting.kr` 도메인 DNS 에 다음 레코드 추가:
```
Type:   CNAME
Host:   report
Target: <GITHUB-USERNAME>.github.io
TTL:    300 (기본값)
```
조직 저장소면 `<ORG>.github.io`. 어느 쪽이든 `.github.io` 가 끝에 붙어야 합니다.

DNS 가 전파되면 (`dig report.univconsulting.kr` 로 확인) GitHub Pages 가 자동으로
Let's Encrypt TLS 인증서를 발급하고 `https://report.univconsulting.kr` 가 라이브가 됩니다.

### 2-6. 보안 헤더
GitHub Pages 는 `_headers` 같은 커스텀 HTTP 헤더 파일을 지원하지 않으므로,
CSP / Referrer-Policy 는 [`app/layout.tsx`](app/layout.tsx) 에서
`<meta http-equiv="Content-Security-Policy">` 와 metadata `referrer` 로 인라인 적용됩니다.

HSTS 는 GitHub Pages 가 커스텀 도메인 HTTPS Enforce 활성화 시 자동으로 설정합니다.

## 3) 동작 확인

**학생 화면:**
```
https://report.univconsulting.kr/?code=202605-honggildong
```
비밀번호 입력 → PDF 가 페이지 안에 임베드되어 표시.

**관리자 화면:**
```
https://report.univconsulting.kr/admin.html
```
"GitHub으로 로그인" → OAuth → UnivConsulting 조직 멤버 확인 → 리포트 등록/목록.

## 관리자 권한 흐름

1. `admin.html` 에서 GitHub OAuth 시작 (`read:org` 스코프)
2. Supabase 가 콜백 처리 후 `admin.html` 로 redirect, session 에 `provider_token` 포함
3. 프론트가 Edge Function `admin-login` 호출 (JWT + `x-github-token` 헤더)
4. Edge Function 이 GitHub `/user/memberships/orgs/UnivConsulting` 조회
5. `state == "active"` 이면 `public.admins` 테이블에 user_id upsert
6. 이후 모든 admin RPC / RLS 가 `is_admin()` 으로 게이팅
7. 관리자에서 빠뜨리고 싶으면 Supabase Studio 에서 `admins` 행을 직접 삭제

## 보안 메모

- 학생 비밀번호: pgcrypto + bcrypt 해시. 평문 저장 없음.
- `reports` / `admins` 테이블: RLS 활성. `reports` 는 admin 만 CRUD, `admins` 는 본인 행만 SELECT 가능.
- Storage: private 버킷. 학생 접근은 Edge Function 이 발급한 10분짜리 signed URL 로만, admin 은 RLS 정책을 통해 직접 업로드.
- service_role 키: Edge Function 내부에만 존재, 브라우저로 절대 노출되지 않음.
- 관리자 OAuth: `read:org` scope 만 요청. 코드/저장소 접근 권한 없음.
- 무차별 대입 대응: 필요 시 학생용 `get-report` 함수에 시도 횟수 제한 / hCaptcha 등을 추가하세요.
