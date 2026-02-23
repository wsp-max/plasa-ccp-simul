# plasmaccp.com 운영 & 수정 & 배포 플레이북 (v1.1)

> 마지막 업데이트: **2025-12-22 (KST)**  
> 대상 환경: **AWS EC2 (Ubuntu 22.04) + nginx(80/443) + Docker + FastAPI(8000) + Route53 + Let’s Encrypt(certbot)**  
> 목적: **실서비스 운영 관점**에서 “0~100 표준 절차”를 문서화 (운영/수정/배포/장애대응/보안/확장)

## 언어 버전 Grid

| 언어 | 문서 파일 | 상태 |
|---|---|---|
| 한국어 (기본) | `plasmaccp_playbook_v1_1_detailed.md` | 최신 |
| 日本語 | `plasmaccp_playbook_v1_1_detailed_ja.md` | 최신 |
| 中文（简体） | `plasmaccp_playbook_v1_1_detailed_zh_cn.md` | 최신 |

---

## 0) 절대 규칙 (반드시 준수)

1) **명령 실행 위치를 항상 구분한다**
- **[로컬 | PowerShell]**
- **[EC2 | Ubuntu bash]**
- **[AWS Console]**

2) **이미 완료된 작업(HTTPS 발급 등)은 다시 하라고 하지 않는다.**  
필요 시 **검증 커맨드**로만 확인한다.

3) **추측 금지**  
불확실하거나 환경별로 달라질 수 있는 내용은,
- (A) **확인 커맨드**로 확정하거나,
- (B) “확실하지 않음”으로 표시하고 확인 절차를 제시한다.

4) 설명은 **실서비스 운영 관점(HTTPS, nginx, Docker, FastAPI, DNS, 보안)**으로 작성한다.

5) 로컬 명령은 **bash 금지**. **PowerShell만** 제공한다.

---

## 1) 변경 이력 / 작업 기록 (운영 로그)

### 1.1 2025-12-22: P0 보안/운영 리스크 2건 조치 완료 ✅
#### (1) nginx `plasma` catch-all(80) → 백엔드(8000) 프록시 제거
- **목표:** 80 포트의 잡트래픽(스캐너/IP 직격)이 백엔드로 유입되지 않게 차단
- **조치:** `/etc/nginx/sites-available/plasma`를 `return 444;`로 변경
- **검증(팩트):**
  - **[로컬 | PowerShell]** `curl.exe -I http://plasmaccp.com` → `301` + `Location: https://plasmaccp.com/`
  - **[로컬 | PowerShell]** `curl.exe -I http://13.124.22.203` → `curl: (52) Empty reply from server` (444 동작 시 정상)
- **롤백:** `plasma.bak.TIMESTAMP`로 복구 후 `nginx -t` → reload

#### (2) Security Group에서 8000 인바운드 차단
- **목표:** 백엔드(8000) 직접 접근 차단(nginx 뒤로 숨김)
- **검증(팩트):**
  - **[로컬 | PowerShell]** `Test-NetConnection 13.124.22.203 -Port 8000` → TCP connect failed (차단 성공)
  - `Ping TimedOut`는 ICMP 차단 시 흔한 정상 경고(열 필요 없음)

---

## 2) 현재 운영 상태 (Fact Snapshot)

### 2.1 인프라/프로세스
- EC2: Ubuntu 22.04
- Public IP: `13.124.22.203`
- nginx: 80/443 서비스
- Docker: 실행 중
- FastAPI: Docker 컨테이너로 실행 중, 호스트 8000 포트 노출(단, **외부 8000 인바운드 차단**)

### 2.2 도메인/DNS
- `plasmaccp.com` → A 레코드 → `13.124.22.203`
- `www.plasmaccp.com` → A 레코드 → `13.124.22.203`
- NS(Hosted Zone) 정합 완료/전파 완료  
- 운영 메모: ISP/사내 DNS 리졸버는 일시적 실패가 가능하므로 **공용 DNS로 교차검증** 루틴을 둔다.

### 2.3 nginx 서비스 구조 (확정)
- 정적 SPA: `/var/www/plasmaccp/dist`
- SPA 라우팅: `try_files ... /index.html`
- API reverse proxy: `/api/ → http://127.0.0.1:8000/`
- HTTP(80): `plasmaccp.com`, `www`는 HTTPS로 301 리다이렉트
- HTTPS(443): TLS 종료 + 정적 서빙 + /api 프록시
- catch-all(80): **return 444** (백엔드로 프록시하지 않음)

### 2.4 nginx 사이트 파일(확정)
- `/etc/nginx/sites-available/plasmaccp.com` (정식 서비스)
- `/etc/nginx/sites-available/plasma` (catch-all: `server_name _;` + `return 444`)
- `/etc/nginx/sites-enabled/`에 위 파일들의 심링크 존재

### 2.5 백엔드(컨테이너) 실행 방식(확정)
- 컨테이너: `plasma-web-simul`
- 포트: `0.0.0.0:8000->8000/tcp` (단, SG에서 외부 차단)
- CMD: `uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1`
- 컨테이너 내부 `/app`에 `main.py, schemas.py, services/, storage/, config.py, requirements.txt, frontend/`

### 2.6 호스트 코드 위치(확정)
- `/home/ubuntu/web_plasma_simul/app` (백엔드 Docker 빌드 기준)
- `/home/ubuntu/web_plasma_simul/frontend` (프론트 소스)

---

## 3) 전체 아키텍처 (트래픽 흐름/역할 분리)

### 3.1 트래픽 흐름 (정상)
1) 사용자 브라우저 → `https://plasmaccp.com/`  
2) Route53 DNS → EC2 Public IP  
3) EC2 nginx(443)에서 TLS 종료  
4) 정적 파일: `/var/www/plasmaccp/dist/*` 서빙  
5) 프론트 JS → `https://plasmaccp.com/api/...` 호출  
6) nginx `/api/` → `http://127.0.0.1:8000/` 프록시  
7) Docker(FastAPI) 응답 → nginx → 브라우저

### 3.2 역할 분리 요약(운영 관점)
- nginx = **Edge** (TLS, 정적, 라우팅, 리다이렉트, 최소 보안)
- FastAPI = **Compute/API** (계산, 스키마 검증, 저장/비교)
- Docker = **배포 단위**
- Route53 = **DNS**
- certbot = **TLS 갱신 자동화**

---

## 4) 운영 표준: 빠른 점검(1~3분 루틴)

### 4.1 서비스 상태 점검
- **[EC2 | Ubuntu bash]**
```bash
sudo systemctl status nginx --no-pager
sudo systemctl status docker --no-pager
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}"
```

### 4.2 외부 접근 점검
- **[로컬 | PowerShell]**
```powershell
curl.exe -I https://plasmaccp.com
curl.exe -I https://www.plasmaccp.com
```

### 4.3 내부 업스트림 점검(nginx → 백엔드)
- **[EC2 | Ubuntu bash]**
```bash
curl -I http://127.0.0.1:8000/
curl -I https://localhost
sudo tail -n 50 /var/log/nginx/error.log
```

완료 기준:
- (A) nginx/docker running
- (B) `https://` 200 OK
- (C) `127.0.0.1:8000` 응답 존재
- (D) nginx error.log에 502/connection refused 없음

---

## 5) nginx 운영 (설정 구조/수정/적용/검증)

### 5.1 표준 변경 절차(무중단)
- **[EC2 | Ubuntu bash]**
```bash
sudo cp -a /etc/nginx /etc/nginx.bak.$(date +%Y%m%d_%H%M%S)
sudo nano /etc/nginx/sites-available/plasmaccp.com
sudo nginx -t
sudo systemctl reload nginx
```

### 5.2 “적용 후” 즉시 검증
- **[EC2 | Ubuntu bash]**
```bash
curl -I https://localhost
sudo tail -n 80 /var/log/nginx/error.log
```

- **[로컬 | PowerShell]**
```powershell
curl.exe -I https://plasmaccp.com
```

### 5.3 catch-all(80) 정책(확정)
- `/etc/nginx/sites-available/plasma`는 백엔드 프록시 금지. (현재 `return 444;`)
- 검증:
- **[로컬 | PowerShell]**
```powershell
curl.exe -I http://13.124.22.203
```

---

## 6) 프론트엔드 수정/빌드/배포 표준 (가장 자세히)

> 목표: **실수 없는 배포**, **원자적 교체**, **즉시 롤백**, **재현 가능한 빌드**

### 6.1 프론트 작업 원칙(운영 관점)
- 프론트는 **항상 `/api/...`로 호출**해야 한다. (405 재발 방지)
- 빌드 산출물은 **dist 하나**다.
- EC2에서는 dist를 **원자적으로 교체**한다(중간 상태 노출 금지).
- 배포 직후 “캐시”로 인해 반영이 늦어 보일 수 있으므로, 검증은 **HTTP 헤더/Last-Modified/ETag**로 확인한다.

### 6.2 개발/수정(로컬)
#### 6.2.1 저장소 위치
- **[로컬 | PowerShell]**
```powershell
cd C:\Users\wsp\Desktop\Web\web_plasma_simul\frontend
```

#### 6.2.2 의존성 설치(권장)
- **[로컬 | PowerShell]**
```powershell
npm ci
```

#### 6.2.3 로컬 실행(선택)
- **[로컬 | PowerShell]**
```powershell
npm run dev
```

#### 6.2.4 빌드
- **[로컬 | PowerShell]**
```powershell
npm run build
```

완료 기준:
- `frontend\dist\index.html` 존재
- `frontend\dist\assets\` 존재

### 6.3 자주 발생하는 문제 & 해결
#### 6.3.1 `vite not found`
- **[로컬 | PowerShell]**
```powershell
cd C:\Users\wsp\Desktop\Web\web_plasma_simul\frontend
npm ci
npm run build
```

#### 6.3.2 “배포했는데 화면이 안 바뀜”
- **[로컬 | PowerShell]**
```powershell
curl.exe -I https://plasmaccp.com
```
`Last-Modified`, `ETag`가 바뀌었는지 확인.

### 6.4 배포(로컬 → EC2 원자 교체)
#### 6.4.1 dist.zip 생성 (권장)
- **[로컬 | PowerShell]**
```powershell
cd C:\Users\wsp\Desktop\Web\web_plasma_simul\frontend
Compress-Archive -Path .\dist\* -DestinationPath .\dist.zip -Force
```

#### 6.4.2 업로드 (권장: dist.zip)
- **[로컬 | PowerShell]**
```powershell
scp -i "C:\Users\wsp\Desktop\Web\web_plasma_simul\plasma-key.pem" `
  .\dist.zip ubuntu@13.124.22.203:/tmp/plasmaccp_dist.zip
```

#### 6.4.2-b 대안(압축 없이 dist 디렉터리 직접 업로드)
- **[로컬 | PowerShell]**
```powershell
scp -i "C:\Users\wsp\Desktop\Web\web_plasma_simul\plasma-key.pem" `
  -r "C:\Users\wsp\Desktop\Web\web_plasma_simul\frontend\dist" `
  ubuntu@13.124.22.203:/tmp/plasmaccp_dist
```

#### 6.4.3 EC2에서 해제 + 검증 (dist.zip 기준)
- 6.4.2-b(직접 업로드)를 썼다면 `unzip` 단계는 건너뛰고 검증만 실행.
- **[EC2 | Ubuntu bash]**
```bash
sudo rm -rf /tmp/plasmaccp_dist
sudo mkdir -p /tmp/plasmaccp_dist
sudo unzip -q /tmp/plasmaccp_dist.zip -d /tmp/plasmaccp_dist

test -f /tmp/plasmaccp_dist/index.html && echo "OK index.html" || (echo "FAIL index.html missing" && exit 1)
test -d /tmp/plasmaccp_dist/assets && echo "OK assets dir" || echo "WARN assets missing"
```

#### 6.4.4 원자적 교체(백업 포함)
- **[EC2 | Ubuntu bash]**
```bash
ts=$(date +%Y%m%d_%H%M%S)
if [ -d /var/www/plasmaccp/dist ]; then
  sudo mv /var/www/plasmaccp/dist /var/www/plasmaccp/dist.bak.$ts
fi
sudo mv /tmp/plasmaccp_dist /var/www/plasmaccp/dist
sudo chown -R root:root /var/www/plasmaccp/dist

sudo nginx -t && sudo systemctl reload nginx
curl -I https://localhost
```

#### 6.4.5 외부 검증
- **[로컬 | PowerShell]**
```powershell
curl.exe -I https://plasmaccp.com
```

### 6.5 프론트 롤백(표준)
- **[EC2 | Ubuntu bash]**
```bash
ls -la /var/www/plasmaccp | egrep "dist\.bak" | tail -n 10
sudo rm -rf /var/www/plasmaccp/dist.bad
sudo mv /var/www/plasmaccp/dist /var/www/plasmaccp/dist.bad
sudo mv /var/www/plasmaccp/dist.bak.YYYYMMDD_HHMMSS /var/www/plasmaccp/dist
sudo systemctl reload nginx
```

---

## 7) 백엔드(FastAPI) 수정/배포 표준 (가장 자세히)

### 7.1 수정 위치(확정)
- **[EC2 | Ubuntu bash]**
```bash
cd ~/web_plasma_simul/app
ls -la
```

### 7.2 기본 점검
- **[EC2 | Ubuntu bash]**
```bash
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}"
curl -I http://127.0.0.1:8000/
docker logs --tail 200 plasma-web-simul
```

### 7.3 배포 표준(EC2 build → canary → 교체)
#### 7.3.1 롤백 준비
- **[EC2 | Ubuntu bash]**
```bash
docker tag plasma-web-simul:latest plasma-web-simul:previous 2>/dev/null || true
```

#### 7.3.2 빌드
- **[EC2 | Ubuntu bash]**
```bash
cd ~/web_plasma_simul/app
docker build -t plasma-web-simul:latest .
```

#### 7.3.3 canary 실행/검증
- **[EC2 | Ubuntu bash]**
```bash
docker rm -f plasma-web-simul-canary 2>/dev/null || true
docker run -d --name plasma-web-simul-canary --restart unless-stopped -p 8001:8000 plasma-web-simul:latest
curl -I http://127.0.0.1:8001/
docker logs --tail 120 plasma-web-simul-canary
```

#### 7.3.4 실컨테이너 교체
- **[EC2 | Ubuntu bash]**
```bash
docker rm -f plasma-web-simul
docker run -d --name plasma-web-simul --restart unless-stopped -p 8000:8000 plasma-web-simul:latest
docker rm -f plasma-web-simul-canary 2>/dev/null || true
```

#### 7.3.5 배포 후 검증
- **[EC2 | Ubuntu bash]**
```bash
curl -I http://127.0.0.1:8000/
sudo tail -n 80 /var/log/nginx/error.log
```

### 7.4 백엔드 롤백
- **[EC2 | Ubuntu bash]**
```bash
docker rm -f plasma-web-simul
docker run -d --name plasma-web-simul --restart unless-stopped -p 8000:8000 plasma-web-simul:previous
```

---

## 8) AWS/EC2 운영 체크리스트(추가)

### 8.1 SG 최소 룰(권장)
- 22/tcp: 내 IP만
- 80/tcp: 0.0.0.0/0, ::/0
- 443/tcp: 0.0.0.0/0, ::/0
- 8000/tcp: **없음(차단)**

### 8.2 리소스/디스크 루틴
- **[EC2 | Ubuntu bash]**
```bash
df -h
free -h
uptime
docker stats --no-stream
```

### 8.3 리스닝 포트 확인
- **[EC2 | Ubuntu bash]**
```bash
sudo ss -lntp | egrep ':80|:443|:8000'
```

---

## 9) HTTPS/인증서 운영(검증만)

- **[EC2 | Ubuntu bash]**
```bash
sudo certbot certificates
sudo certbot renew --dry-run
sudo nginx -t && sudo systemctl reload nginx
```

---

## 10) 장애 대응 최소 체크리스트

### 10.1 502
- **[EC2 | Ubuntu bash]**
```bash
curl -I http://127.0.0.1:8000/
docker logs --tail 200 plasma-web-simul
sudo tail -n 120 /var/log/nginx/error.log
```

### 10.2 405
- 프론트 호출 경로 `/api/simulate` 확인

---

# 끝
