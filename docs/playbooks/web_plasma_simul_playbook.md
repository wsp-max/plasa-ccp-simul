# Web Plasma Simul 운영 Playbook (Single-Server FastAPI + React)

> 마지막 업데이트: 2025-12-22 (KST)  
> 대상 환경: **EC2 단일 서버 + Docker + FastAPI(8000) + Vite/React 정적 빌드**  
> 접근 방식: **백엔드가 프론트 정적 파일을 직접 서빙**, 별도 nginx/도메인 없이 `http://<EC2_IP>:8000/`

---

## 1) 서비스 목적 (무엇을 하는가)

- **Plasma Web Simulator**는 브라우저에서 공정 조건(압력, RF 파워, 가스, 유입 등)을 입력하면
  **axisymmetric r-z Poisson 기반 계산**(또는 stub)을 실행하고,
  **전기장/밀도/Sheath/Proxy 곡선**을 Plotly 기반 UI로 시각화하는 서비스다.
- 핵심 API는 `POST /simulate` 하나이며, 계산 모드는 `stub`, `poisson_v1`.
- 응답이 큰 경우 **S3 또는 로컬 파일로 저장**하고 `result_url`로 제공한다.

---

## 2) 현재 구성 요약 (아키텍처)

```
브라우저
  └─(HTTP GET /)─> FastAPI (StaticFiles: frontend/dist)
  └─(HTTP POST /simulate)─> FastAPI
         └─ compute_poisson_v1 (async to_thread + timeout)
         └─ 결과가 크면 S3 또는 로컬 저장
```

- **단일 서버**: FastAPI가 UI 정적 파일을 직접 서빙.
- **Docker 멀티스테이지 빌드**: 프론트 빌드 → backend 이미지에 `frontend/dist` 복사.
- **CORS 미사용**: 같은 origin에서 UI/API 통신.

---

## 3) 레포 구조 (핵심 경로)

- `app/main.py`: FastAPI 엔트리포인트, `/simulate` 및 StaticFiles 마운트.
- `app/schemas.py`: 요청/응답 Pydantic 스키마 (strict: `extra="forbid"`).
- `app/services/compute_poisson_v1.py`: Poisson 기반 계산 핵심.
- `app/services/compute_stub.py`: 개발용 stub 결과 생성.
- `app/services/s3_store.py`: 결과 저장 (S3 또는 로컬).
- `frontend/src/`: React/TSX UI.
- `frontend/legacy/`: **과거 레거시 UI (빌드에 포함되지 않음)**.
- `frontend/dist/`: 빌드 결과물 (배포 대상).
- `tests/`: 스키마/Poisson 계산 테스트.

---

## 4) 핵심 동작 (API/계산/정적 서빙)

### 4.1 API 엔드포인트
- `POST /simulate?mode=stub|poisson_v1`
  - 요청은 `schemas.py`의 `SimulationRequest`에 엄격히 부합해야 함.
  - `mode=poisson_v1`일 때:
    - `asyncio.to_thread()`로 계산 분리
    - `SIM_TIMEOUT_SECONDS` 초과 시 **504 Timeout**
  - 요청 크기/결과 크기가 큰 경우:
    - `INLINE_MAX_BYTES` 초과 시 **S3 또는 로컬 저장**
    - `result_url` 제공

### 4.2 동시성 제한
- `SIM_SEMAPHORE = 1`로 **동시에 1건만 처리**.
- 동시 요청이 들어오면 **429** 응답 가능.

### 4.3 정적 파일 서빙 조건
- `frontend/dist/index.html`이 **존재할 때만** `/`에 StaticFiles 마운트.
- 즉, **dist가 없으면 `/`는 404**가 정상이다.

---

## 5) 환경 변수 (운영 필수/선택)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `SIM_TIMEOUT_SECONDS` | `30` | poisson_v1 계산 타임아웃(초) |
| `INLINE_MAX_BYTES` | `200000` | 인라인 응답 최대 크기 (초과 시 저장) |
| `S3_BUCKET` | `""` | S3 버킷 이름 (없으면 로컬 저장) |
| `S3_PREFIX` | `plasma-results/` | S3 키 프리픽스 |
| `PRESIGN_EXPIRY_SECONDS` | `3600` | presigned URL 만료 |
| `LOCAL_STORAGE_DIR` | OS temp 경로 | 로컬 저장 디렉터리 |

**참고:** `boto3`가 설치되어 있고 AWS 자격 증명이 있을 때만 S3 저장이 활성화된다.

---

## 6) 빌드/실행 가이드

### 6.1 로컬 개발 (Windows/PowerShell)
```powershell
# frontend
cd C:\Users\wsp\Desktop\Web\web_plasma_simul\frontend
npm install
npm run dev

# backend
cd C:\Users\wsp\Desktop\Web\web_plasma_simul\app
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```
- dev 환경에서 API 기본 경로는 동일 origin(`""`)이므로, 필요 시 UI에서 직접 API Base 입력.
- 또는 `VITE_API_BASE=http://127.0.0.1:8000` 사용.

### 6.2 Docker 빌드/실행 (EC2 권장)
```bash
cd ~/web_plasma_simul
docker build -f app/Dockerfile -t plasma-web-simul .
docker run -d --name plasma-web-simul --restart unless-stopped -p 8000:8000 plasma-web-simul
```

### 6.3 기본 헬스체크
```bash
curl -I http://127.0.0.1:8000/
curl -I http://127.0.0.1:8000/docs
curl -I http://127.0.0.1:8000/openapi.json
```

---

## 7) 운영 점검 체크리스트 (Daily / On-Deploy)

### 7.1 서비스 상태
```bash
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}"
docker logs --tail 200 plasma-web-simul
```

### 7.2 정적 서빙 확인
```bash
curl -I http://127.0.0.1:8000/
```
- 200 OK: dist 정상
- 404: `frontend/dist/index.html` 없음 → 프론트 빌드 누락

### 7.3 /simulate 간단 확인
```bash
curl -X POST "http://127.0.0.1:8000/simulate?mode=stub" \
  -H "Content-Type: application/json" \
  -d @/tmp/sample_payload.json
```

---

## 8) 장애 대응 가이드

### 8.1 404 on `/`
- 원인: `frontend/dist/index.html` 없음
- 조치:
  - Docker 재빌드 (`docker build ...`)
  - 또는 `frontend` 빌드 후 dist 복사

### 8.2 422 (ValidationError)
- 원인: 스키마 불일치 (`app/schemas.py`)
- 조치:
  - 요청 JSON을 `SimulationRequest`에 맞춤
  - 프론트 타입(`frontend/src/types/api.ts`)과 동기화

### 8.3 429
- 원인: `SIM_SEMAPHORE` 동시성 제한
- 조치:
  - 부하를 낮추거나 서버 스케일 아웃 검토

### 8.4 504
- 원인: `SIM_TIMEOUT_SECONDS` 초과
- 조치:
  - 격자 크기(nr/nz) 줄이기
  - `SIM_TIMEOUT_SECONDS` 증가

### 8.5 500
- 원인: 계산 중 예외 / 수치 불안정 / 저장 실패
- 조치:
  - `docker logs` 확인
  - Poisson solver 입력값 검증

---

## 9) 코드 수정 가이드 (유지보수 관점)

### 9.1 스키마 변경 시
1. `app/schemas.py` 수정
2. `frontend/src/types/api.ts` 동기화
3. `tests/test_schema_validation.py` 업데이트

### 9.2 Poisson 계산 로직 수정
1. `app/services/compute_poisson_v1.py` 수정
2. `tests/test_poisson_v1.py` 통과 확인
3. 성능/수치 안정성 체크

### 9.3 S3 저장 활성화
1. `boto3`를 `app/requirements.txt`에 추가
2. EC2에 AWS 자격 증명 설정
3. `S3_BUCKET`/`S3_PREFIX` 환경 변수 지정

---

## 10) 테스트 실행

### 10.1 Python 테스트
```bash
cd ~/web_plasma_simul
PYTHONPATH=app pytest
```

---

## 11) 보안/네트워크 가이드

- **기본 접근**: `http://<EC2_IP>:8000/`
- 보안 그룹 인바운드 권장:
  - `22/tcp`: 관리자 IP만
  - `8000/tcp`: 서비스 공개 (필요시 IP 제한)

---

## 12) 운영 메모

- `frontend/dist`는 **빌드 산출물**이므로 직접 수정하지 않는다.
- `frontend/legacy`는 **빌드 제외 영역**.
- SciPy가 설치되면 sparse solver를 사용하므로 속도 개선 가능.

---

## 13) 상태 확인 (외부에서)

```powershell
curl.exe -I http://<EC2_IP>:8000/
```
- 응답이 없으면:
  - 보안 그룹/네트워크 확인
  - 컨테이너 실행 상태 점검
  - 로컬에서 `curl http://127.0.0.1:8000/` 확인

