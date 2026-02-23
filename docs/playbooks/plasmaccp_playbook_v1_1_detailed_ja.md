# plasmaccp.com 運用・修正・デプロイ プレイブック (v1.1 / 日本語)

> 最終更新: **2025-12-22 (KST)**  
> 対象環境: **AWS EC2 (Ubuntu 22.04) + nginx(80/443) + Docker + FastAPI(8000) + Route53 + Let’s Encrypt(certbot)**  
> 目的: **実サービス運用の観点**で「0〜100の標準手順」を文書化（運用/修正/デプロイ/障害対応/セキュリティ/拡張）

## 言語バージョン Grid

| 言語 | ドキュメントファイル | 状態 |
|---|---|---|
| 한국어 (基本) | `plasmaccp_playbook_v1_1_detailed.md` | 最新 |
| 日本語 | `plasmaccp_playbook_v1_1_detailed_ja.md` | 最新 |
| 中文（简体） | `plasmaccp_playbook_v1_1_detailed_zh_cn.md` | 最新 |

---

## 0) 絶対ルール（必ず遵守）

1) **コマンド実行場所を常に区別する**
- **[ローカル | PowerShell]**
- **[EC2 | Ubuntu bash]**
- **[AWS Console]**

2) **既に完了した作業（HTTPS 発行など）は再実施しない。**  
必要な場合は **検証コマンド** でのみ確認する。

3) **推測禁止**  
不確実な内容、または環境依存の内容は、
- (A) **確認コマンド** で確定する、
- (B) 「未確定」と明示して確認手順を提示する。

4) 説明は **実サービス運用の観点（HTTPS, nginx, Docker, FastAPI, DNS, セキュリティ）** で記述する。

5) ローカルコマンドは **bash 禁止**。**PowerShell のみ** 提供する。

---

## 1) 変更履歴 / 作業記録（運用ログ）

### 1.1 2025-12-22: P0 セキュリティ/運用リスク 2件の対応完了 ✅
#### (1) nginx `plasma` catch-all(80) → バックエンド(8000) へのプロキシ削除
- **目的:** 80 ポートのノイズトラフィック（スキャナ/IP直打ち）がバックエンドへ流入しないよう遮断
- **対応:** `/etc/nginx/sites-available/plasma` を `return 444;` に変更
- **検証（事実）:**
  - **[ローカル | PowerShell]** `curl.exe -I http://plasmaccp.com` → `301` + `Location: https://plasmaccp.com/`
  - **[ローカル | PowerShell]** `curl.exe -I http://13.124.22.203` → `curl: (52) Empty reply from server`（444 動作時は正常）
- **ロールバック:** `plasma.bak.TIMESTAMP` に復元後 `nginx -t` → reload

#### (2) Security Group で 8000 インバウンドを遮断
- **目的:** バックエンド（8000）への直接アクセスを遮断（nginx の背後へ隠蔽）
- **検証（事実）:**
  - **[ローカル | PowerShell]** `Test-NetConnection 13.124.22.203 -Port 8000` → TCP connect failed（遮断成功）
  - `Ping TimedOut` は ICMP 遮断時に一般的な正常警告（開放不要）

---

## 2) 現在の運用状態（Fact Snapshot）

### 2.1 インフラ/プロセス
- EC2: Ubuntu 22.04
- Public IP: `13.124.22.203`
- nginx: 80/443 サービス
- Docker: 実行中
- FastAPI: Docker コンテナで実行中、ホスト 8000 ポート公開（ただし **外部 8000 インバウンドは遮断**）

### 2.2 ドメイン/DNS
- `plasmaccp.com` → A レコード → `13.124.22.203`
- `www.plasmaccp.com` → A レコード → `13.124.22.203`
- NS（Hosted Zone）整合完了/伝播完了  
- 運用メモ: ISP/社内 DNS リゾルバは一時的に失敗することがあるため、**公共 DNS でクロス検証** する運用にする。

### 2.3 nginx サービス構成（確定）
- 静的 SPA: `/var/www/plasmaccp/dist`
- SPA ルーティング: `try_files ... /index.html`
- API reverse proxy: `/api/ → http://127.0.0.1:8000/`
- HTTP(80): `plasmaccp.com`, `www` は HTTPS に 301 リダイレクト
- HTTPS(443): TLS 終端 + 静的配信 + /api プロキシ
- catch-all(80): **return 444**（バックエンドへはプロキシしない）

### 2.4 nginx サイトファイル（確定）
- `/etc/nginx/sites-available/plasmaccp.com`（正式サービス）
- `/etc/nginx/sites-available/plasma`（catch-all: `server_name _;` + `return 444`）
- `/etc/nginx/sites-enabled/` に上記ファイルのシンボリックリンクあり

### 2.5 バックエンド（コンテナ）実行方式（確定）
- コンテナ: `plasma-web-simul`
- ポート: `0.0.0.0:8000->8000/tcp`（ただし SG で外部遮断）
- CMD: `uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1`
- コンテナ内部 `/app` に `main.py, schemas.py, services/, storage/, config.py, requirements.txt, frontend/`

### 2.6 ホストコード位置（確定）
- `/home/ubuntu/web_plasma_simul/app`（バックエンド Docker ビルド基準）
- `/home/ubuntu/web_plasma_simul/frontend`（フロントソース）

---

## 3) 全体アーキテクチャ（トラフィックフロー/役割分離）

### 3.1 トラフィックフロー（正常）
1) ユーザーブラウザ → `https://plasmaccp.com/`  
2) Route53 DNS → EC2 Public IP  
3) EC2 nginx(443) で TLS 終端  
4) 静的ファイル: `/var/www/plasmaccp/dist/*` を配信  
5) フロント JS → `https://plasmaccp.com/api/...` を呼び出し  
6) nginx `/api/` → `http://127.0.0.1:8000/` へプロキシ  
7) Docker(FastAPI) 応答 → nginx → ブラウザ

### 3.2 役割分離の要約（運用観点）
- nginx = **Edge**（TLS, 静的, ルーティング, リダイレクト, 最低限の防御）
- FastAPI = **Compute/API**（計算, スキーマ検証, 保存/比較）
- Docker = **デプロイ単位**
- Route53 = **DNS**
- certbot = **TLS 更新自動化**

---

## 4) 運用標準: クイック点検（1〜3分ルーチン）

### 4.1 サービス状態点検
- **[EC2 | Ubuntu bash]**
```bash
sudo systemctl status nginx --no-pager
sudo systemctl status docker --no-pager
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}"
```

### 4.2 外部アクセス点検
- **[ローカル | PowerShell]**
```powershell
curl.exe -I https://plasmaccp.com
curl.exe -I https://www.plasmaccp.com
```

### 4.3 内部アップストリーム点検（nginx → バックエンド）
- **[EC2 | Ubuntu bash]**
```bash
curl -I http://127.0.0.1:8000/
curl -I https://localhost
sudo tail -n 50 /var/log/nginx/error.log
```

完了基準:
- (A) nginx/docker running
- (B) `https://` 200 OK
- (C) `127.0.0.1:8000` 応答あり
- (D) nginx error.log に 502/connection refused がない

---

## 5) nginx 運用（設定構造/修正/適用/検証）

### 5.1 標準変更手順（無停止）
- **[EC2 | Ubuntu bash]**
```bash
sudo cp -a /etc/nginx /etc/nginx.bak.$(date +%Y%m%d_%H%M%S)
sudo nano /etc/nginx/sites-available/plasmaccp.com
sudo nginx -t
sudo systemctl reload nginx
```

### 5.2 「適用後」即時検証
- **[EC2 | Ubuntu bash]**
```bash
curl -I https://localhost
sudo tail -n 80 /var/log/nginx/error.log
```

- **[ローカル | PowerShell]**
```powershell
curl.exe -I https://plasmaccp.com
```

### 5.3 catch-all(80) ポリシー（確定）
- `/etc/nginx/sites-available/plasma` はバックエンドへのプロキシ禁止（現在 `return 444;`）
- 検証:
- **[ローカル | PowerShell]**
```powershell
curl.exe -I http://13.124.22.203
```

---

## 6) フロントエンド修正/ビルド/デプロイ標準（最詳細）

> 目標: **ミスのないデプロイ**, **原子的切り替え**, **即時ロールバック**, **再現可能なビルド**

### 6.1 フロント作業原則（運用観点）
- フロントは **必ず `/api/...` で呼び出す**（405 再発防止）
- ビルド成果物は **dist 1つ**
- EC2 では dist を **原子的に切り替え** する（中間状態を公開しない）
- デプロイ直後はキャッシュで反映遅延が見える場合があるため、検証は **HTTP ヘッダ/Last-Modified/ETag** で行う

### 6.2 開発/修正（ローカル）
#### 6.2.1 リポジトリ位置
- **[ローカル | PowerShell]**
```powershell
cd C:\Users\wsp\Desktop\Web\web_plasma_simul\frontend
```

#### 6.2.2 依存関係インストール（推奨）
- **[ローカル | PowerShell]**
```powershell
npm ci
```

#### 6.2.3 ローカル実行（任意）
- **[ローカル | PowerShell]**
```powershell
npm run dev
```

#### 6.2.4 ビルド
- **[ローカル | PowerShell]**
```powershell
npm run build
```

完了基準:
- `frontend\dist\index.html` が存在
- `frontend\dist\assets\` が存在

### 6.3 よくある問題と対処
#### 6.3.1 `vite not found`
- **[ローカル | PowerShell]**
```powershell
cd C:\Users\wsp\Desktop\Web\web_plasma_simul\frontend
npm ci
npm run build
```

#### 6.3.2 「デプロイしたのに画面が変わらない」
- **[ローカル | PowerShell]**
```powershell
curl.exe -I https://plasmaccp.com
```
`Last-Modified`, `ETag` が変わったか確認する。

### 6.4 デプロイ（ローカル → EC2 原子的切り替え）
#### 6.4.1 dist.zip 作成（推奨）
- **[ローカル | PowerShell]**
```powershell
cd C:\Users\wsp\Desktop\Web\web_plasma_simul\frontend
Compress-Archive -Path .\dist\* -DestinationPath .\dist.zip -Force
```

#### 6.4.2 アップロード（推奨: dist.zip）
- **[ローカル | PowerShell]**
```powershell
scp -i "C:\Users\wsp\Desktop\Web\web_plasma_simul\plasma-key.pem" `
  .\dist.zip ubuntu@13.124.22.203:/tmp/plasmaccp_dist.zip
```

#### 6.4.2-b 代替（圧縮せず dist ディレクトリを直接アップロード）
- **[ローカル | PowerShell]**
```powershell
scp -i "C:\Users\wsp\Desktop\Web\web_plasma_simul\plasma-key.pem" `
  -r "C:\Users\wsp\Desktop\Web\web_plasma_simul\frontend\dist" `
  ubuntu@13.124.22.203:/tmp/plasmaccp_dist
```

#### 6.4.3 EC2 で展開 + 検証（dist.zip 基準）
- 6.4.2-b（直接アップロード）を使った場合、`unzip` はスキップして検証のみ実行。
- **[EC2 | Ubuntu bash]**
```bash
sudo rm -rf /tmp/plasmaccp_dist
sudo mkdir -p /tmp/plasmaccp_dist
sudo unzip -q /tmp/plasmaccp_dist.zip -d /tmp/plasmaccp_dist

test -f /tmp/plasmaccp_dist/index.html && echo "OK index.html" || (echo "FAIL index.html missing" && exit 1)
test -d /tmp/plasmaccp_dist/assets && echo "OK assets dir" || echo "WARN assets missing"
```

#### 6.4.4 原子的切り替え（バックアップ込み）
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

#### 6.4.5 外部検証
- **[ローカル | PowerShell]**
```powershell
curl.exe -I https://plasmaccp.com
```

### 6.5 フロントロールバック（標準）
- **[EC2 | Ubuntu bash]**
```bash
ls -la /var/www/plasmaccp | egrep "dist\.bak" | tail -n 10
sudo rm -rf /var/www/plasmaccp/dist.bad
sudo mv /var/www/plasmaccp/dist /var/www/plasmaccp/dist.bad
sudo mv /var/www/plasmaccp/dist.bak.YYYYMMDD_HHMMSS /var/www/plasmaccp/dist
sudo systemctl reload nginx
```

---

## 7) バックエンド（FastAPI）修正/デプロイ標準（最詳細）

### 7.1 修正位置（確定）
- **[EC2 | Ubuntu bash]**
```bash
cd ~/web_plasma_simul/app
ls -la
```

### 7.2 基本点検
- **[EC2 | Ubuntu bash]**
```bash
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}"
curl -I http://127.0.0.1:8000/
docker logs --tail 200 plasma-web-simul
```

### 7.3 デプロイ標準（EC2 build → canary → 切り替え）
#### 7.3.1 ロールバック準備
- **[EC2 | Ubuntu bash]**
```bash
docker tag plasma-web-simul:latest plasma-web-simul:previous 2>/dev/null || true
```

#### 7.3.2 ビルド
- **[EC2 | Ubuntu bash]**
```bash
cd ~/web_plasma_simul/app
docker build -t plasma-web-simul:latest .
```

#### 7.3.3 canary 実行/検証
- **[EC2 | Ubuntu bash]**
```bash
docker rm -f plasma-web-simul-canary 2>/dev/null || true
docker run -d --name plasma-web-simul-canary --restart unless-stopped -p 8001:8000 plasma-web-simul:latest
curl -I http://127.0.0.1:8001/
docker logs --tail 120 plasma-web-simul-canary
```

#### 7.3.4 本番コンテナ切り替え
- **[EC2 | Ubuntu bash]**
```bash
docker rm -f plasma-web-simul
docker run -d --name plasma-web-simul --restart unless-stopped -p 8000:8000 plasma-web-simul:latest
docker rm -f plasma-web-simul-canary 2>/dev/null || true
```

#### 7.3.5 デプロイ後検証
- **[EC2 | Ubuntu bash]**
```bash
curl -I http://127.0.0.1:8000/
sudo tail -n 80 /var/log/nginx/error.log
```

### 7.4 バックエンドロールバック
- **[EC2 | Ubuntu bash]**
```bash
docker rm -f plasma-web-simul
docker run -d --name plasma-web-simul --restart unless-stopped -p 8000:8000 plasma-web-simul:previous
```

---

## 8) AWS/EC2 運用チェックリスト（追加）

### 8.1 SG 最小ルール（推奨）
- 22/tcp: 自分の IP のみ
- 80/tcp: 0.0.0.0/0, ::/0
- 443/tcp: 0.0.0.0/0, ::/0
- 8000/tcp: **なし（遮断）**

### 8.2 リソース/ディスク ルーチン
- **[EC2 | Ubuntu bash]**
```bash
df -h
free -h
uptime
docker stats --no-stream
```

### 8.3 リッスンポート確認
- **[EC2 | Ubuntu bash]**
```bash
sudo ss -lntp | egrep ':80|:443|:8000'
```

---

## 9) HTTPS/証明書運用（検証のみ）

- **[EC2 | Ubuntu bash]**
```bash
sudo certbot certificates
sudo certbot renew --dry-run
sudo nginx -t && sudo systemctl reload nginx
```

---

## 10) 障害対応 最小チェックリスト

### 10.1 502
- **[EC2 | Ubuntu bash]**
```bash
curl -I http://127.0.0.1:8000/
docker logs --tail 200 plasma-web-simul
sudo tail -n 120 /var/log/nginx/error.log
```

### 10.2 405
- フロントの呼び出し経路 `/api/simulate` を確認

---

# 終わり
