# plasmaccp.com 운영 & 수정 & 배포 플레이북 (v1.3 / Ultra Detailed + Git 표준화)

> 마지막 업데이트: **2025-12-22 (KST)**  
> 대상 환경: **AWS EC2 (Ubuntu 22.04) + nginx(80/443) + Docker + FastAPI(8000) + Route53 + Let’s Encrypt(certbot)**  
> 향후 확장 포함: **GitHub 기반 표준화 / 팀 협업 / 자동화 전 단계**

---

## 0) 이 문서의 위치 (아주 중요)

이 플레이북은:
- **“지금 혼자 운영”**에도 맞고
- **“나중에 팀원이 들어와도 그대로 따라 하면 되는 수준”**을 목표로 한다.

따라서:
- *지금 안 쓰는 도구(GitHub Actions 등)*도  
  👉 **“언제 / 왜 / 어떤 구조로 도입할지”까지 미리 문서화**한다.
- 단, **지금 당장 해야 할 것과 미래 표준을 명확히 구분**한다.

---

# Part 0. 절대 규칙 (재확인)

1) 모든 명령은 실행 위치를 반드시 명시
   - **[로컬 | PowerShell]**
   - **[Git | 로컬]**
   - **[EC2 | Ubuntu bash]**
   - **[AWS Console]**

2) 실서비스에서:
   - “될 것 같음” ❌
   - “아마도” ❌  
   👉 **검증 커맨드가 없는 작업은 금지**

3) Git/GitHub은 **배포 도구가 아니라 “상태 보존 도구”**로 먼저 사용한다.

---

# Part A. Git 표준화 설계 (아직 안 써도 됨, 하지만 구조는 지금 확정)

## A1) 왜 지금 Git 구조부터 정해야 하나?

> 이유는 단 하나:
> **“운영 중인 서비스는 반드시 ‘과거로 돌아갈 수 있어야’ 안전하다.”**

Git이 없으면:
- 어떤 코드가 배포돼 있는지 **기억에 의존**
- 장애 시 “어제랑 뭐가 달라졌지?” → **답이 없음**

Git이 있으면:
- *언제 / 누가 / 무엇을* 바꿨는지 즉시 확인
- 롤백 기준이 **코드 단위로 명확**

---

## A2) 저장소 분리 전략 (권장안)

### ✅ 1안 (강력 추천)
```text
plasmaccp-frontend/
plasmaccp-backend/
```

**이유**
- 배포 주기 다름
- 책임 다름
- CI/CD 붙일 때 분리된 게 훨씬 유리

### ⚠️ 2안 (초기 편의)
```text
plasmaccp/
 ├ frontend/
 └ backend/
```

→ 나중에 분리 가능하지만, **CI/CD 전환 시 작업량 증가**

---

## A3) Git 브랜치 전략 (운영 친화형)

> Git Flow ❌ (너무 무거움)  
> Trunk-based ❌ (자동화 없으면 위험)

### 권장 브랜치
```text
main        ← 실서비스 기준 (배포 가능한 상태만)
develop     ← 다음 배포 준비
feature/*   ← 기능 단위 작업
hotfix/*    ← 운영 중 긴급 수정
```

### 절대 규칙
- **EC2에서 직접 코드 수정 ❌**
- **main 브랜치 = 현재 서비스 상태**

---

# Part B. Local 개발 표준 (Git 포함)

## B1) 로컬 개발 기본 흐름 (프론트/백엔드 공통)

### 실행 위치
- **[로컬 | PowerShell]**

```powershell
git clone https://github.com/<your-org>/plasmaccp-frontend.git
cd plasmaccp-frontend
git checkout develop
```

### 작업 시작 시
```powershell
git checkout -b feature/ui-sheath-graph
```

### 작업 완료 후
```powershell
git status
git add .
git commit -m "feat: add sheath profile graph"
git push origin feature/ui-sheath-graph
```

---

## B2) 커밋 메시지 규칙 (운영용)

> 나중에 로그처럼 쓰인다. **사람이 읽을 수 있어야 한다.**

```text
feat: 새로운 기능
fix: 버그 수정
ops: 운영 설정 변경 (nginx, docker, env)
docs: 문서 수정
refactor: 리팩토링 (동작 변경 없음)
```

❌ `update`, `test`, `temp` 같은 메시지 금지

---

# Part C. Git ↔ 배포 관계 정의 (아주 중요)

## C1) Git은 “자동 배포 트리거”가 아니다 (현재 기준)

지금 단계에서는:
- Git push → **아무 일도 안 일어남**
- 배포는 여전히 **수동 + 플레이북 기반**

👉 이유:
- 지금은 **운영 안정성 > 자동화**
- 자동화는 *표준이 완전히 굳은 뒤* 도입

---

## C2) 하지만 반드시 지켜야 할 연결 규칙

### 배포 전 체크 (필수)
- **지금 배포하는 코드가 Git에 있는가?**
- **커밋 해시를 알고 있는가?**

```powershell
git rev-parse HEAD
```

➡️ 이 해시는 **운영 기록에 남긴다**

---

# Part D. Backend + Git 연동 표준

## D1) 백엔드 배포 전 Git 기준점 고정

### 실행
- **[로컬 | PowerShell]**
```powershell
git checkout main
git pull
git rev-parse HEAD
```

### 운영 로그에 기록
```text
2025-12-22
Backend deploy
Commit: a1b2c3d4
```

---

## D2) EC2 배포는 “Git clone 대상이 아님”

> **중요 철학**

- EC2는 **빌드/실행 환경**
- Git clone을 EC2에서 직접 하지 않는다 (지금 단계에서는)

이유:
- 실수로 main 브랜치에서 수정할 위험
- SSH 키/권한/보안 관리 복잡

👉 EC2에는:
- **빌드 결과물(dist, docker image)**만 전달

---

# Part E. Frontend + Git 연동 표준

## E1) 프론트 배포 전 필수 확인

### 로컬
```powershell
git status
git branch
git rev-parse HEAD
npm run build
```

### 원칙
- **커밋 안 된 코드로 배포 ❌**
- dist는 Git에 올리지 않는다

---

## E2) 배포 기록 템플릿 (문서에 남김)

```text
[Frontend Deploy]
Date: 2025-12-22
Repo: plasmaccp-frontend
Branch: main
Commit: e9f1c2a
Operator: wsp
Result: OK
```

---

# Part F. 미래 확장: GitHub Actions (지금은 안 함)

## F1) 언제 도입할까?

아래가 모두 만족되면:
- 배포 절차가 **3회 이상 동일하게 반복**
- 롤백이 **한 번도 실패한 적 없음**
- nginx / docker 구조가 1달 이상 안정

👉 그때:
- `build → scp → swap` 자동화

---

## F2) 미래 CI/CD 구조(개념도)

```text
GitHub (main)
   ↓
Actions
   ↓
Build (frontend / backend)
   ↓
Artifact
   ↓
EC2 deploy
```

※ 이 문서에서는 **의도적으로 구현 안 함**

---

# Part G. EC2 운영 + Git 관점 보강

## G1) “EC2에서 수정하면 안 되는 것”

- Python 코드
- frontend 코드
- nginx 설정(긴급 제외)

👉 수정은 **항상 로컬 → Git → 배포**

---

## G2) 예외: EC2에서 허용되는 작업

- 로그 확인
- 컨테이너 재시작
- nginx reload
- 임시 디버깅(코드 변경 후 **즉시 롤백**)

---

# Part H. 운영 사고를 막는 핵심 원칙 7가지

1) EC2는 **작업장이 아니다**
2) Git에 없는 코드는 **존재하지 않는 코드**
3) 배포 전에 항상 **커밋 해시 확인**
4) 프론트와 백엔드는 **배포 루트가 다르다**
5) nginx는 **최후의 방어선**
6) 8000은 **외부에 절대 열지 않는다**
7) 자동화는 **사람 실수 0이 확인된 뒤**

---

# 끝 (v1.3)
