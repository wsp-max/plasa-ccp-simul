# plasmaccp.com 운영 & 수정 & 배포 플레이북 (v1)

> 마지막 업데이트: 2025-12-22 (KST)  
> 대상 환경: **AWS EC2 (Ubuntu 22.04) + nginx(80/443) + Docker + FastAPI(8000) + Route53 + Let’s Encrypt(certbot)**  
> 목적: **실서비스 운영 관점**에서 “0~100 표준 절차”를 문서화 (운영/수정/배포/장애대응/보안/확장)

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

## 1) 현재 운영 상태 (Fact Snapshot)

### 1.1 인프라/프로세스
- EC2: Ubuntu 22.04
- Public IP: `13.124.22.203`
- nginx: 80/443 서비스
- Docker: 실행 중
- FastAPI: Docker 컨테이너로 실행 중, 호스트 8000 포트 노출

### 1.2 도메인/DNS
- `plasmaccp.com` → A 레코드 → `13.124.22.203`
- `www.plasmaccp.com` → A 레코드 → `13.124.22.203`
- NS(Hosted Zone) 정합 완료/전파 완료
- 관측: 일부 리졸버에서 `www` 조회가 실패할 수 있음(운영 체크리스트에 포함)

### 1.3 nginx 서비스 구조 (확정)
- 정적 SPA: `/var/www/plasmaccp/dist`
- SPA 라우팅: `try_files ... /index.html`
- API reverse proxy: `/api/ → http://127.0.0.1:8000/`
- HTTP(80): `plasmaccp.com`, `www` 요청은 HTTPS로 301 리다이렉트 (certbot 관리 블록)
- HTTPS(443): TLS 종료 + 정적 서빙 + /api 프록시

### 1.4 nginx 사이트 파일(확정)
- `/etc/nginx/sites-available/plasmaccp.com` (정식 서비스)
- `/etc/nginx/sites-available/plasma` (catch-all: `server_name _;` + 80에서 8000 프록시)

### 1.5 백엔드(컨테이너) 실행 방식(확정)
- 컨테이너: `plasma-web-simul`
- 포트: `0.0.0.0:8000->8000/tcp`
- CMD: `uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1`
- 컨테이너 내부 `/app`에 `main.py, schemas.py, services/, storage/, config.py, requirements.txt, frontend/`

### 1.6 호스트 코드 위치(확정)
- `/home/ubuntu/web_plasma_simul/app` (백엔드 Docker 빌드 기준)
- `/home/ubuntu/web_plasma_simul/frontend` (프론트 소스)

### 1.7 plasmaccp.com nginx 설정(확정, 원문)
```nginx
server {

    server_name plasmaccp.com www.plasmaccp.com;

    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    root /var/www/plasmaccp/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8000/;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /api {
        return 301 /api/;
    }

    listen [::]:443 ssl ipv6only=on; # managed by Certbot
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/plasmaccp.com/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/plasmaccp.com/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot

}
server {
    if ($host = www.plasmaccp.com) {
        return 301 https://$host$request_uri;
    } # managed by Certbot

    if ($host = plasmaccp.com) {
        return 301 https://$host$request_uri;
    } # managed by Certbot

    listen 80;
    listen [::]:80;

    server_name plasmaccp.com www.plasmaccp.com;
    return 404; # managed by Certbot
}
```

### 1.8 plasma nginx 설정(catch-all, 확정 원문)
```nginx
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 2) 전체 아키텍처 (트래픽 흐름/역할 분리)

### 2.1 트래픽 흐름 (정상)
1) 사용자 브라우저 → `https://plasmaccp.com/`  
2) Route53 DNS → EC2 Public IP  
3) EC2 nginx(443)에서 TLS 종료  
4) 정적 파일: `/var/www/plasmaccp/dist/*` 서빙  
5) 프론트 JS → `https://plasmaccp.com/api/...` 호출  
6) nginx `/api/` → `http://127.0.0.1:8000/` 프록시  
7) Docker(FastAPI) 응답 → nginx → 브라우저

### 2.2 구성요소 역할
- Route53: 도메인 → IP
- nginx: Edge(HTTPS 종료, 정적, API 프록시, 리다이렉트)
- FastAPI: 계산/응답
- Docker: 백엔드 배포/실행 단위
- certbot: 인증서 갱신 자동화

### 2.3 왜 이렇게 분리하는가 (운영 관점)
- 장애를 “DNS / nginx / 백엔드”로 빠르게 분리한다.
- 프론트 정적은 교체만으로 배포 가능(가장 안정적).
- API는 `/api`로 경계를 만들어 CORS/Mixed Content 리스크를 줄인다.
- 추후 CloudFront/서브도메인 분리에 유리하다.

---

## 3) 운영 표준: 빠른 점검(1~3분 루틴)

> **목표:** 장애/이상 징후를 “빠르게” 감지하고, 어디 문제인지 1차 분리

### 3.1 서비스 상태 점검
- **[EC2 | Ubuntu bash]**
```bash
sudo systemctl status nginx --no-pager
sudo systemctl status docker --no-pager
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}"
```

완료 기준:
- nginx/docker: active (running)
- 컨테이너 `plasma-web-simul` Up 상태

### 3.2 로컬에서 외부 접근 점검
- **[로컬 | PowerShell]**
```powershell
curl.exe -I https://plasmaccp.com
curl.exe -I https://www.plasmaccp.com
```

완료 기준:
- `HTTP/1.1 200 OK` (또는 304) 응답
- Server: nginx

### 3.3 EC2 내부에서 내부 경로 점검(Upstream 확인)
- **[EC2 | Ubuntu bash]**
```bash
curl -I http://127.0.0.1:8000/
curl -I https://localhost
sudo tail -n 50 /var/log/nginx/error.log
```

완료 기준:
- `127.0.0.1:8000`이 응답(200/404/405 등 “응답이 존재”)
- nginx error.log에 502/connection refused가 없다

---

## 4) nginx 운영 (설정 구조/수정/적용/검증)

### 4.1 파일 구조(정답)
- 전역: `/etc/nginx/nginx.conf`
  - 포함: `include /etc/nginx/sites-enabled/*;`
- 사이트(실서비스):
  - `/etc/nginx/sites-available/plasmaccp.com`
  - `/etc/nginx/sites-enabled/plasmaccp.com` (심링크)
- 사이트(캐치올):
  - `/etc/nginx/sites-available/plasma`
  - `/etc/nginx/sites-enabled/plasma` (심링크)

### 4.2 server_name 매칭/우선순위 (운영자가 반드시 아는 규칙)
nginx는 들어오는 요청(Host 헤더, listen 포트)에 대해 다음 순서로 server block을 고른다(요약):
- 같은 `listen` 포트 내에서 **가장 구체적인 `server_name`**이 우선
- `server_name _;`는 사실상 “캐치올” 역할
- `default_server`가 있으면 그게 최후 fallback
- 실무적으로는 “plasmaccp.com”처럼 명시된 server_name이 `_`보다 우선한다.

**왜 중요한가?**
- 현재 `plasma`가 80에서 모든 Host를 8000으로 넘기므로,  
  “내가 의도한 80 리다이렉트가 안 먹는다” 같은 이슈가 생기면 이 규칙으로 원인을 찾는다.

### 4.3 catch-all(plasma)의 의미와 운영 리스크
현재 `plasma`는 80으로 들어오는 “모든 Host”를 8000으로 프록시한다.

**운영 리스크(정확한 이유):**
- IP 직격, 잘못된 Host, 스캐너가 80으로 던지는 요청이 전부 FastAPI로 들어감
- 백엔드 로그 오염 + 공격면 확대
- 장기적으로 도메인 추가/리다이렉트 정책 변경 시 혼란 유발

**중요:**  
`plasmaccp.com`/`www.plasmaccp.com`은 일반적으로 더 구체적인 server_name이 우선 매칭되어 리다이렉트가 정상 동작한다.  
하지만 운영 표준 관점에서는 catch-all을 프록시로 두지 않는 편이 안전하다.

### 4.4 nginx 설정 변경 표준 절차 (무중단)

#### 4.4.1 변경 전 백업
- **[EC2 | Ubuntu bash]**
```bash
sudo cp -a /etc/nginx /etc/nginx.bak.$(date +%Y%m%d_%H%M%S)
```

#### 4.4.2 편집(대상 파일 정확히 선택)
- 실서비스:
- **[EC2 | Ubuntu bash]**
```bash
sudo nano /etc/nginx/sites-available/plasmaccp.com
```

- catch-all:
- **[EC2 | Ubuntu bash]**
```bash
sudo nano /etc/nginx/sites-available/plasma
```

#### 4.4.3 문법 검사(필수)
- **[EC2 | Ubuntu bash]**
```bash
sudo nginx -t
```

#### 4.4.4 적용(무중단 reload)
- **[EC2 | Ubuntu bash]**
```bash
sudo systemctl reload nginx
```

#### 4.4.5 적용 후 즉시 검증
- **[EC2 | Ubuntu bash]**
```bash
curl -I https://localhost
sudo tail -n 80 /var/log/nginx/error.log
```

완료 기준:
- `nginx -t` 성공
- reload 성공
- localhost에서 200 OK

### 4.5 plasma(catch-all) 처리: 운영 표준 권장안(선택 적용)
**원칙:** “catch-all은 백엔드로 프록시하지 않는다”

권장안 A(더 강력): 444로 즉시 드랍
```nginx
server {
    listen 80;
    server_name _;
    return 444;
}
```

권장안 B(보수적): 404로 종료
```nginx
server {
    listen 80;
    server_name _;
    return 404;
}
```

적용 절차(표준):
- **[EC2 | Ubuntu bash]**
```bash
sudo cp -a /etc/nginx/sites-available/plasma /etc/nginx/sites-available/plasma.bak.$(date +%Y%m%d_%H%M%S)
sudo nano /etc/nginx/sites-available/plasma
sudo nginx -t
sudo systemctl reload nginx
```

완료 기준:
- nginx reload 성공
- 외부에서 “IP:80 직격” 시 백엔드로 안 들어감 (아래 검증)

검증(권장):
- **[로컬 | PowerShell]**
```powershell
curl.exe -I http://13.124.22.203
```
- 기대 결과: 404 또는 연결 종료(444는 클라이언트에 따라 “빈 응답”처럼 보일 수 있음)

---

## 5) 프론트엔드 운영/배포 표준 절차 (로컬 빌드 → 업로드 → 원자적 교체)

> 목표: “실수 없는 배포”, “즉시 롤백 가능”, “캐시 이슈 최소화”

### 5.1 로컬 빌드(Windows)

#### 5.1.1 Node/npm 버전 확인
- **[로컬 | PowerShell]**
```powershell
node -v
npm -v
```

#### 5.1.2 의존성 설치(권장: npm ci)
- **[로컬 | PowerShell]**
```powershell
cd C:\Users\wsp\desktop\web\web_plasma_simul\frontend
npm ci
```

#### 5.1.3 빌드
- **[로컬 | PowerShell]**
```powershell
npm run build
```

완료 기준:
- `frontend\dist\index.html` 존재
- `frontend\dist\assets\` 존재

### 5.2 자주 발생: `vite not found`
원인:
- node_modules 미설치/깨짐

해결:
- **[로컬 | PowerShell]**
```powershell
cd C:\Users\wsp\desktop\web\web_plasma_simul\frontend
if (Test-Path .\node_modules) { "node_modules exists" } else { "missing node_modules" }
npm ci
npm run build
```

### 5.3 배포 패키징 & 업로드

#### 5.3.1 dist.zip 생성
- **[로컬 | PowerShell]**
```powershell
cd C:\Users\wsp\desktop\web\web_plasma_simul\frontend
Compress-Archive -Path .\dist\* -DestinationPath .\dist.zip -Force
```

#### 5.3.2 scp 업로드
- **[로컬 | PowerShell]**
```powershell
scp -i "C:\Users\wsp\desktop\web\web_plasma_simul\plasma-key.pem" `
  .\dist.zip ubuntu@13.124.22.203:/tmp/plasmaccp_dist.zip
```

완료 기준:
- scp 에러 없이 종료

### 5.4 EC2에서 원자적 교체(Atomic Swap)

#### 5.4.1 staging에 압축 해제
- **[EC2 | Ubuntu bash]**
```bash
sudo rm -rf /tmp/plasmaccp_dist
sudo mkdir -p /tmp/plasmaccp_dist
sudo unzip -q /tmp/plasmaccp_dist.zip -d /tmp/plasmaccp_dist
```

#### 5.4.2 산출물 검증(필수)
- **[EC2 | Ubuntu bash]**
```bash
test -f /tmp/plasmaccp_dist/index.html && echo "OK index.html" || echo "FAIL index.html missing"
test -d /tmp/plasmaccp_dist/assets && echo "OK assets dir" || echo "WARN assets missing"
```

#### 5.4.3 dist 백업 + 교체
- **[EC2 | Ubuntu bash]**
```bash
ts=$(date +%Y%m%d_%H%M%S)
if [ -d /var/www/plasmaccp/dist ]; then
  sudo mv /var/www/plasmaccp/dist /var/www/plasmaccp/dist.bak.$ts
fi
sudo mv /tmp/plasmaccp_dist /var/www/plasmaccp/dist
sudo chown -R root:root /var/www/plasmaccp/dist
```

#### 5.4.4 적용 & 검증
- **[EC2 | Ubuntu bash]**
```bash
sudo nginx -t && sudo systemctl reload nginx
curl -I https://localhost
```

- **[로컬 | PowerShell]**
```powershell
curl.exe -I https://plasmaccp.com
```

완료 기준:
- HTTPS 200 OK
- 최신 index.html이 반영(필요 시 Last-Modified 확인)

### 5.5 롤백 표준
- **[EC2 | Ubuntu bash]**
```bash
ls -la /var/www/plasmaccp | egrep "dist\.bak" | tail -n 10
# 원하는 백업 선택 후:
sudo rm -rf /var/www/plasmaccp/dist.bad
sudo mv /var/www/plasmaccp/dist /var/www/plasmaccp/dist.bad
sudo mv /var/www/plasmaccp/dist.bak.YYYYMMDD_HHMMSS /var/www/plasmaccp/dist
sudo systemctl reload nginx
```

---

## 6) 백엔드(FastAPI) 운영/배포 표준 절차 (Docker 중심)

> 목표: 빌드/검증/교체/롤백 표준화

### 6.1 일상 운영(상태/로그/헬스체크)
- **[EC2 | Ubuntu bash]**
```bash
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}"
curl -I http://127.0.0.1:8000/
docker logs --tail 200 plasma-web-simul
```

완료 기준:
- 컨테이너 Up
- 127.0.0.1:8000 응답 존재

### 6.2 배포 표준(EC2에서 빌드 → canary → 교체)

#### 6.2.1 배포 직전 “이전 태그 보존”(롤백 준비)
- **[EC2 | Ubuntu bash]**
```bash
docker tag plasma-web-simul:latest plasma-web-simul:previous 2>/dev/null || true
```

#### 6.2.2 빌드
- **[EC2 | Ubuntu bash]**
```bash
cd ~/web_plasma_simul/app
docker build -t plasma-web-simul:latest .
```

#### 6.2.3 canary 검증(권장)
- **[EC2 | Ubuntu bash]**
```bash
docker rm -f plasma-web-simul-canary 2>/dev/null || true
docker run -d --name plasma-web-simul-canary --restart unless-stopped -p 8001:8000 plasma-web-simul:latest
curl -I http://127.0.0.1:8001/
docker logs --tail 120 plasma-web-simul-canary
```

#### 6.2.4 실컨테이너 교체
- **[EC2 | Ubuntu bash]**
```bash
docker rm -f plasma-web-simul
docker run -d --name plasma-web-simul --restart unless-stopped -p 8000:8000 plasma-web-simul:latest
docker rm -f plasma-web-simul-canary 2>/dev/null || true
```

#### 6.2.5 배포 후 검증(nginx 경유 포함)
- **[EC2 | Ubuntu bash]**
```bash
curl -I http://127.0.0.1:8000/
curl -I https://localhost/api/ 2>/dev/null || true
sudo tail -n 80 /var/log/nginx/error.log
```

### 6.3 롤백 표준
- **[EC2 | Ubuntu bash]**
```bash
docker rm -f plasma-web-simul
docker run -d --name plasma-web-simul --restart unless-stopped -p 8000:8000 plasma-web-simul:previous
```

---

## 7) HTTPS/인증서 운영 (검증 중심)

### 7.1 인증서 상태 확인(월 1회 또는 배포 전)
- **[EC2 | Ubuntu bash]**
```bash
sudo certbot certificates
sudo openssl x509 -enddate -noout -in /etc/letsencrypt/live/plasmaccp.com/fullchain.pem
```

### 7.2 자동갱신 타이머 확인
- **[EC2 | Ubuntu bash]**
```bash
sudo systemctl status certbot.timer --no-pager
sudo journalctl -u certbot --since "14 days ago" --no-pager | tail -n 150
```

### 7.3 갱신 dry-run(분기 1회)
- **[EC2 | Ubuntu bash]**
```bash
sudo certbot renew --dry-run
```

### 7.4 갱신 후 nginx reload
- **[EC2 | Ubuntu bash]**
```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## 8) AWS 네트워크/보안그룹 체크리스트

### 8.1 권장 Inbound 규칙
- 22/tcp: 내 IP만
- 80/tcp: 0.0.0.0/0, ::/0
- 443/tcp: 0.0.0.0/0, ::/0
- 8000/tcp: 닫기 권장(nginx 뒤)

### 8.2 8000 외부 오픈 점검
- **[로컬 | PowerShell]**
```powershell
Test-NetConnection -ComputerName 13.124.22.203 -Port 8000
```

- **[AWS Console]**
  - SG Inbound rules에서 8000 제거(권장)

---

## 9) 운영 안정화(최소 튜닝)

### 9.1 nginx: 정적 캐시(assets 강캐시, index no-cache)
- 이유: 배포 후 캐시 문제 최소화
- 적용 위치: `/etc/nginx/sites-available/plasmaccp.com`

검증:
- **[로컬 | PowerShell]**
```powershell
curl.exe -I https://plasmaccp.com/
```

### 9.2 nginx: gzip(텍스트만)
- 이유: JS/CSS/JSON/HTML 대역폭 감소

---

## 10) 확장 설계(CloudFront / api 서브도메인)

### 10.1 CloudFront(구조 유지)
- Origin=EC2 nginx
- `/api/*`는 캐시 OFF
- 정적은 캐시 ON

### 10.2 api.plasmaccp.com 분리
- Route53 레코드 추가
- nginx server block 추가
- cert에 SAN 추가

---

## 11) 릴리즈 체크리스트(배포 전/후)

### 배포 전
- **[로컬 | PowerShell]** 빌드 성공, `/api/*` 호출 확인
- **[EC2 | Ubuntu bash]**
```bash
df -h
sudo nginx -t
docker ps
curl -I http://127.0.0.1:8000/
```

### 배포 후
- **[로컬 | PowerShell]**
```powershell
curl.exe -I https://plasmaccp.com
curl.exe -I https://plasmaccp.com/api/ 2>$null
```

---

## 12) 장애 대응 체크리스트(대표)

### 12.1 접속 불가
- 로컬 443 확인 → AWS 상태 체크 → nginx status

### 12.2 502
- upstream(8000) 응답 확인 → docker logs → nginx error.log

### 12.3 404(SPA)
- try_files 확인

### 12.4 405
- 프론트가 `/api/simulate`로 호출하는지 확인

---

## 13) 보안 체크리스트(HSTS/CSP/로그)

### 13.1 HSTS
- www 포함 도메인 안정화 후 적용 권장
검증:
- **[로컬 | PowerShell]**
```powershell
curl.exe -I https://plasmaccp.com | findstr -i strict-transport-security
```

### 13.2 CSP
- 광고 도입 시 Report-Only → 단계적 강화 권장

### 13.3 로그
- **[EC2 | Ubuntu bash]**
```bash
sudo tail -n 80 /var/log/nginx/access.log
sudo tail -n 80 /var/log/nginx/error.log
docker logs --tail 120 plasma-web-simul
```

---

## 14) DNS(www 조회 실패) 표준 점검

- **[로컬 | PowerShell]**
```powershell
nslookup www.plasmaccp.com 1.1.1.1
nslookup www.plasmaccp.com 8.8.8.8
```

- **[AWS Console]**
  - Hosted zone 중복 여부 확인
  - www A 레코드 위치/값 확인

---

## 15) 부록: 매일 쓰는 커맨드 15개

- **[EC2 | Ubuntu bash]**
```bash
docker ps
docker logs --tail 80 plasma-web-simul
curl -I http://127.0.0.1:8000/
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl status nginx --no-pager
sudo systemctl status docker --no-pager
sudo tail -n 80 /var/log/nginx/error.log
sudo tail -n 80 /var/log/nginx/access.log
df -h
docker system df
sudo certbot certificates
sudo systemctl status certbot.timer --no-pager
sudo ss -lntp | egrep ':80|:443|:8000'
```

---

# 끝
