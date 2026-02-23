# plasmaccp.com 运维、修改与发布手册 (v1.1 / 中文简体)

> 最后更新: **2025-12-22 (KST)**  
> 目标环境: **AWS EC2 (Ubuntu 22.04) + nginx(80/443) + Docker + FastAPI(8000) + Route53 + Let’s Encrypt(certbot)**  
> 目的: 从**线上服务运维视角**文档化“0~100 标准流程”（运维/修改/发布/故障处理/安全/扩展）

## 语言版本 Grid

| 语言 | 文档文件 | 状态 |
|---|---|---|
| 한국어（默认） | `plasmaccp_playbook_v1_1_detailed.md` | 最新 |
| 日本語 | `plasmaccp_playbook_v1_1_detailed_ja.md` | 最新 |
| 中文（简体） | `plasmaccp_playbook_v1_1_detailed_zh_cn.md` | 最新 |

---

## 0) 绝对规则（必须遵守）

1) **始终区分命令执行位置**
- **[本地 | PowerShell]**
- **[EC2 | Ubuntu bash]**
- **[AWS Console]**

2) **已经完成的工作（例如 HTTPS 证书签发）不要重复执行。**  
必要时只用 **验证命令** 进行确认。

3) **禁止猜测**  
对于不确定或因环境不同可能变化的内容：
- (A) 用 **确认命令** 固化结论，
- (B) 明确标注“尚不确定”，并给出确认步骤。

4) 说明必须站在 **线上运维视角（HTTPS, nginx, Docker, FastAPI, DNS, 安全）** 编写。

5) 本地命令 **禁止 bash**，仅提供 **PowerShell**。

---

## 1) 变更历史 / 工作记录（运维日志）

### 1.1 2025-12-22: P0 安全/运维风险 2 项处置完成 ✅
#### (1) nginx `plasma` catch-all(80) → 移除到后端(8000)的代理
- **目标:** 阻断 80 端口杂流量（扫描器/IP 直连）进入后端
- **措施:** 将 `/etc/nginx/sites-available/plasma` 改为 `return 444;`
- **验证（事实）:**
  - **[本地 | PowerShell]** `curl.exe -I http://plasmaccp.com` → `301` + `Location: https://plasmaccp.com/`
  - **[本地 | PowerShell]** `curl.exe -I http://13.124.22.203` → `curl: (52) Empty reply from server`（444 生效时为正常）
- **回滚:** 用 `plasma.bak.TIMESTAMP` 恢复后执行 `nginx -t` → reload

#### (2) Security Group 中关闭 8000 入站
- **目标:** 阻断后端(8000)直连访问（仅通过 nginx）
- **验证（事实）:**
  - **[本地 | PowerShell]** `Test-NetConnection 13.124.22.203 -Port 8000` → TCP connect failed（阻断成功）
  - `Ping TimedOut` 在 ICMP 被禁时属于常见正常提示（无需放开）

---

## 2) 当前运行状态（Fact Snapshot）

### 2.1 基础设施/进程
- EC2: Ubuntu 22.04
- Public IP: `13.124.22.203`
- nginx: 80/443 服务中
- Docker: 运行中
- FastAPI: 以 Docker 容器运行，主机暴露 8000 端口（但 **外部 8000 入站已阻断**）

### 2.2 域名/DNS
- `plasmaccp.com` → A 记录 → `13.124.22.203`
- `www.plasmaccp.com` → A 记录 → `13.124.22.203`
- NS（Hosted Zone）已一致/已传播  
- 运维备注: ISP/公司内 DNS 解析器可能有短时失败，建议建立 **公共 DNS 交叉验证** 例行检查。

### 2.3 nginx 服务结构（已确认）
- 静态 SPA: `/var/www/plasmaccp/dist`
- SPA 路由: `try_files ... /index.html`
- API reverse proxy: `/api/ → http://127.0.0.1:8000/`
- HTTP(80): `plasmaccp.com`, `www` 重定向到 HTTPS（301）
- HTTPS(443): TLS 终止 + 静态资源服务 + /api 代理
- catch-all(80): **return 444**（不再代理到后端）

### 2.4 nginx 站点文件（已确认）
- `/etc/nginx/sites-available/plasmaccp.com`（正式服务）
- `/etc/nginx/sites-available/plasma`（catch-all: `server_name _;` + `return 444`）
- `/etc/nginx/sites-enabled/` 下存在以上文件的软链接

### 2.5 后端（容器）运行方式（已确认）
- 容器: `plasma-web-simul`
- 端口: `0.0.0.0:8000->8000/tcp`（但 SG 已做外部阻断）
- CMD: `uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1`
- 容器内 `/app` 包含 `main.py, schemas.py, services/, storage/, config.py, requirements.txt, frontend/`

### 2.6 主机代码路径（已确认）
- `/home/ubuntu/web_plasma_simul/app`（后端 Docker 构建基准路径）
- `/home/ubuntu/web_plasma_simul/frontend`（前端源码）

---

## 3) 整体架构（流量路径/职责拆分）

### 3.1 流量路径（正常）
1) 用户浏览器 → `https://plasmaccp.com/`  
2) Route53 DNS → EC2 Public IP  
3) 在 EC2 nginx(443) 完成 TLS 终止  
4) 静态文件: `/var/www/plasmaccp/dist/*` 提供服务  
5) 前端 JS → 调用 `https://plasmaccp.com/api/...`  
6) nginx `/api/` → 代理到 `http://127.0.0.1:8000/`  
7) Docker(FastAPI) 响应 → nginx → 浏览器

### 3.2 职责拆分摘要（运维视角）
- nginx = **Edge**（TLS、静态、路由、重定向、最小安全）
- FastAPI = **Compute/API**（计算、Schema 校验、存储/对比）
- Docker = **发布单元**
- Route53 = **DNS**
- certbot = **TLS 自动续期**

---

## 4) 运维标准: 快速巡检（1~3 分钟）

### 4.1 服务状态巡检
- **[EC2 | Ubuntu bash]**
```bash
sudo systemctl status nginx --no-pager
sudo systemctl status docker --no-pager
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}"
```

### 4.2 外部访问巡检
- **[本地 | PowerShell]**
```powershell
curl.exe -I https://plasmaccp.com
curl.exe -I https://www.plasmaccp.com
```

### 4.3 内部上游巡检（nginx → 后端）
- **[EC2 | Ubuntu bash]**
```bash
curl -I http://127.0.0.1:8000/
curl -I https://localhost
sudo tail -n 50 /var/log/nginx/error.log
```

完成标准:
- (A) nginx/docker running
- (B) `https://` 200 OK
- (C) `127.0.0.1:8000` 有响应
- (D) nginx error.log 中无 502/connection refused

---

## 5) nginx 运维（配置结构/修改/应用/验证）

### 5.1 标准变更流程（无中断）
- **[EC2 | Ubuntu bash]**
```bash
sudo cp -a /etc/nginx /etc/nginx.bak.$(date +%Y%m%d_%H%M%S)
sudo nano /etc/nginx/sites-available/plasmaccp.com
sudo nginx -t
sudo systemctl reload nginx
```

### 5.2 “应用后”立即验证
- **[EC2 | Ubuntu bash]**
```bash
curl -I https://localhost
sudo tail -n 80 /var/log/nginx/error.log
```

- **[本地 | PowerShell]**
```powershell
curl.exe -I https://plasmaccp.com
```

### 5.3 catch-all(80) 策略（已确认）
- `/etc/nginx/sites-available/plasma` 禁止代理后端（当前 `return 444;`）
- 验证:
- **[本地 | PowerShell]**
```powershell
curl.exe -I http://13.124.22.203
```

---

## 6) 前端修改/构建/发布标准（最详细）

> 目标: **零失误发布**, **原子替换**, **快速回滚**, **可复现构建**

### 6.1 前端工作原则（运维视角）
- 前端必须 **始终调用 `/api/...`**（防止 405 再发）
- 构建产物只有 **dist**
- 在 EC2 上对 dist 进行 **原子替换**（避免中间态暴露）
- 发布后可能因缓存看起来“未生效”，应通过 **HTTP Header/Last-Modified/ETag** 验证

### 6.2 开发/修改（本地）
#### 6.2.1 仓库位置
- **[本地 | PowerShell]**
```powershell
cd C:\Users\wsp\Desktop\Web\web_plasma_simul\frontend
```

#### 6.2.2 依赖安装（推荐）
- **[本地 | PowerShell]**
```powershell
npm ci
```

#### 6.2.3 本地运行（可选）
- **[本地 | PowerShell]**
```powershell
npm run dev
```

#### 6.2.4 构建
- **[本地 | PowerShell]**
```powershell
npm run build
```

完成标准:
- `frontend\dist\index.html` 存在
- `frontend\dist\assets\` 存在

### 6.3 常见问题与处理
#### 6.3.1 `vite not found`
- **[本地 | PowerShell]**
```powershell
cd C:\Users\wsp\Desktop\Web\web_plasma_simul\frontend
npm ci
npm run build
```

#### 6.3.2 “发布了但页面没变化”
- **[本地 | PowerShell]**
```powershell
curl.exe -I https://plasmaccp.com
```
检查 `Last-Modified`、`ETag` 是否变化。

### 6.4 发布（本地 → EC2 原子替换）
#### 6.4.1 生成 dist.zip（推荐）
- **[本地 | PowerShell]**
```powershell
cd C:\Users\wsp\Desktop\Web\web_plasma_simul\frontend
Compress-Archive -Path .\dist\* -DestinationPath .\dist.zip -Force
```

#### 6.4.2 上传（推荐: dist.zip）
- **[本地 | PowerShell]**
```powershell
scp -i "C:\Users\wsp\Desktop\Web\web_plasma_simul\plasma-key.pem" `
  .\dist.zip ubuntu@13.124.22.203:/tmp/plasmaccp_dist.zip
```

#### 6.4.2-b 备选（不压缩，直接上传 dist 目录）
- **[本地 | PowerShell]**
```powershell
scp -i "C:\Users\wsp\Desktop\Web\web_plasma_simul\plasma-key.pem" `
  -r "C:\Users\wsp\Desktop\Web\web_plasma_simul\frontend\dist" `
  ubuntu@13.124.22.203:/tmp/plasmaccp_dist
```

#### 6.4.3 在 EC2 解压 + 验证（以 dist.zip 为准）
- 如果使用 6.4.2-b（直传目录），跳过 `unzip`，仅执行校验。
- **[EC2 | Ubuntu bash]**
```bash
sudo rm -rf /tmp/plasmaccp_dist
sudo mkdir -p /tmp/plasmaccp_dist
sudo unzip -q /tmp/plasmaccp_dist.zip -d /tmp/plasmaccp_dist

test -f /tmp/plasmaccp_dist/index.html && echo "OK index.html" || (echo "FAIL index.html missing" && exit 1)
test -d /tmp/plasmaccp_dist/assets && echo "OK assets dir" || echo "WARN assets missing"
```

#### 6.4.4 原子替换（含备份）
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

#### 6.4.5 外部验证
- **[本地 | PowerShell]**
```powershell
curl.exe -I https://plasmaccp.com
```

### 6.5 前端回滚（标准）
- **[EC2 | Ubuntu bash]**
```bash
ls -la /var/www/plasmaccp | egrep "dist\.bak" | tail -n 10
sudo rm -rf /var/www/plasmaccp/dist.bad
sudo mv /var/www/plasmaccp/dist /var/www/plasmaccp/dist.bad
sudo mv /var/www/plasmaccp/dist.bak.YYYYMMDD_HHMMSS /var/www/plasmaccp/dist
sudo systemctl reload nginx
```

---

## 7) 后端（FastAPI）修改/发布标准（最详细）

### 7.1 修改位置（已确认）
- **[EC2 | Ubuntu bash]**
```bash
cd ~/web_plasma_simul/app
ls -la
```

### 7.2 基础巡检
- **[EC2 | Ubuntu bash]**
```bash
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}"
curl -I http://127.0.0.1:8000/
docker logs --tail 200 plasma-web-simul
```

### 7.3 发布标准（EC2 build → canary → 替换）
#### 7.3.1 回滚准备
- **[EC2 | Ubuntu bash]**
```bash
docker tag plasma-web-simul:latest plasma-web-simul:previous 2>/dev/null || true
```

#### 7.3.2 构建
- **[EC2 | Ubuntu bash]**
```bash
cd ~/web_plasma_simul/app
docker build -t plasma-web-simul:latest .
```

#### 7.3.3 canary 启动/验证
- **[EC2 | Ubuntu bash]**
```bash
docker rm -f plasma-web-simul-canary 2>/dev/null || true
docker run -d --name plasma-web-simul-canary --restart unless-stopped -p 8001:8000 plasma-web-simul:latest
curl -I http://127.0.0.1:8001/
docker logs --tail 120 plasma-web-simul-canary
```

#### 7.3.4 正式容器替换
- **[EC2 | Ubuntu bash]**
```bash
docker rm -f plasma-web-simul
docker run -d --name plasma-web-simul --restart unless-stopped -p 8000:8000 plasma-web-simul:latest
docker rm -f plasma-web-simul-canary 2>/dev/null || true
```

#### 7.3.5 发布后验证
- **[EC2 | Ubuntu bash]**
```bash
curl -I http://127.0.0.1:8000/
sudo tail -n 80 /var/log/nginx/error.log
```

### 7.4 后端回滚
- **[EC2 | Ubuntu bash]**
```bash
docker rm -f plasma-web-simul
docker run -d --name plasma-web-simul --restart unless-stopped -p 8000:8000 plasma-web-simul:previous
```

---

## 8) AWS/EC2 运维检查清单（补充）

### 8.1 SG 最小规则（推荐）
- 22/tcp: 仅我的 IP
- 80/tcp: 0.0.0.0/0, ::/0
- 443/tcp: 0.0.0.0/0, ::/0
- 8000/tcp: **无（阻断）**

### 8.2 资源/磁盘例行检查
- **[EC2 | Ubuntu bash]**
```bash
df -h
free -h
uptime
docker stats --no-stream
```

### 8.3 监听端口确认
- **[EC2 | Ubuntu bash]**
```bash
sudo ss -lntp | egrep ':80|:443|:8000'
```

---

## 9) HTTPS/证书运维（仅验证）

- **[EC2 | Ubuntu bash]**
```bash
sudo certbot certificates
sudo certbot renew --dry-run
sudo nginx -t && sudo systemctl reload nginx
```

---

## 10) 故障处理最小检查清单

### 10.1 502
- **[EC2 | Ubuntu bash]**
```bash
curl -I http://127.0.0.1:8000/
docker logs --tail 200 plasma-web-simul
sudo tail -n 120 /var/log/nginx/error.log
```

### 10.2 405
- 确认前端调用路径为 `/api/simulate`

---

# 结束
