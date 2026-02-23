#!/usr/bin/env python3

import datetime as dt
import gzip
import ipaddress
import json
import os
import re
import shutil
import smtplib
import socket
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from email.message import EmailMessage
from pathlib import Path

# nginx combined (default) ends with: "<bytes> "<referer>" "<user-agent>""
# Some environments may log only up to <bytes>, so referer/ua are optional.
LOG_RE = re.compile(
    r'^(?P<ip>\S+) \S+ \S+ \[(?P<ts>[^\]]+)\] "(?P<req>[^"]*)" (?P<status>\d{3}) (?P<body>\S+)'
    r'(?: "(?P<referer>[^"]*)" "(?P<ua>[^"]*)")?'
    r'(?: .*)?$'
)

DEFAULT_ENV_PATH = Path('/opt/plasmaccp/monitor/.env')
DEFAULT_GEO_CACHE_PATH = Path('/opt/plasmaccp/monitor/geo_cache.json')


def _as_bool(s: str) -> bool:
    return str(s or '').strip().lower() in {'1', 'true', 'yes', 'y', 'on'}


def is_public_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (
        addr.is_private
        or addr.is_loopback
        or addr.is_multicast
        or addr.is_unspecified
        or addr.is_reserved
        or addr.is_link_local
    )


def _safe_trunc(s: str, n: int = 120) -> str:
    s = (s or '').strip()
    if len(s) <= n:
        return s
    return s[: max(0, n - 1)] + '…'


def _normalize_path(raw_path: str) -> str:
    raw_path = (raw_path or '').strip()
    if not raw_path:
        return raw_path
    # Strip query string to avoid exploding cardinality in the report.
    return raw_path.split('?', 1)[0]


def _domain_from_url(url: str) -> str:
    url = (url or '').strip()
    if not url or url == '-':
        return '-'
    try:
        parsed = urllib.parse.urlparse(url)
        host = (parsed.netloc or '').strip().lower()
        return host or '-'
    except Exception:
        return '-'


def _load_json(path: Path) -> dict:
    try:
        if not path.exists():
            return {}
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return {}


def _write_json(path: Path, payload: dict):
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True), encoding='utf-8')
    except Exception:
        pass


def geo_lookup_ipapi(ip: str, timeout_sec: float = 2.0) -> dict:
    # https://ipapi.co/<ip>/json/ (free tier has rate limits; we only query top IPs)
    url = f'https://ipapi.co/{ip}/json/'
    req = urllib.request.Request(url, headers={'User-Agent': 'plasmaccp-monitor/1.0'})
    with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
        data = json.loads(resp.read().decode('utf-8', errors='ignore') or '{}')
    # Normalize a small, stable subset.
    return {
        'country': (data.get('country_name') or '').strip() or None,
        'country_code': (data.get('country_code') or '').strip() or None,
        'region': (data.get('region') or '').strip() or None,
        'city': (data.get('city') or '').strip() or None,
        'org': (data.get('org') or '').strip() or None,
    }


def geo_lookup(ip: str, provider: str = 'ipapi', timeout_sec: float = 2.0) -> dict | None:
    provider = (provider or 'ipapi').strip().lower()
    try:
        if provider == 'ipapi':
            return geo_lookup_ipapi(ip, timeout_sec=timeout_sec)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError):
        return None
    except Exception:
        return None
    return None


def parse_env(path: Path):
    env = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        env[k.strip()] = v.strip()
    return env


def read_lines(path: Path):
    if not path.exists() or path.is_dir():
        return []
    try:
        if path.suffix == '.gz':
            with gzip.open(path, 'rt', encoding='utf-8', errors='ignore') as f:
                return f.readlines()
        with path.open('r', encoding='utf-8', errors='ignore') as f:
            return f.readlines()
    except Exception:
        return []


def human_bytes(n: int) -> str:
    step = 1024.0
    units = ['B', 'KB', 'MB', 'GB', 'TB']
    v = float(max(0, n))
    for u in units:
        if v < step:
            return f'{v:.2f} {u}'
        v /= step
    return f'{v:.2f} PB'


def get_meminfo():
    data = {}
    try:
        with open('/proc/meminfo', 'r', encoding='utf-8') as f:
            for line in f:
                if ':' not in line:
                    continue
                k, v = line.split(':', 1)
                data[k.strip()] = int(v.strip().split()[0])
    except Exception:
        pass
    total = data.get('MemTotal', 0)
    avail = data.get('MemAvailable', 0)
    used = max(0, total - avail)
    return total * 1024, used * 1024, avail * 1024


def get_cpu_percent(sample_sec: float = 0.8):
    def snap():
        with open('/proc/stat', 'r', encoding='utf-8') as f:
            parts = f.readline().split()[1:]
            vals = list(map(int, parts))
            total = sum(vals)
            idle = vals[3] + vals[4] if len(vals) > 4 else vals[3]
            return total, idle

    try:
        import time
        t1, i1 = snap()
        time.sleep(sample_sec)
        t2, i2 = snap()
        dt_total = max(1, t2 - t1)
        dt_idle = max(0, i2 - i1)
        busy = 100.0 * (dt_total - dt_idle) / dt_total
        return max(0.0, min(100.0, busy))
    except Exception:
        return None


def parse_nginx_last_hours(
    hours: float = 24,
    log_dir: Path = Path('/var/log/nginx'),
    now: dt.datetime | None = None,
):
    now = now or dt.datetime.now(dt.timezone.utc)
    cutoff = now - dt.timedelta(hours=max(0.01, float(hours)))

    status_counter = Counter()
    ip_counter = Counter()
    path_counter = Counter()
    api_path_counter = Counter()
    referer_domain_counter = Counter()
    referer_full_counter = Counter()
    ua_counter = Counter()
    method_counter = Counter()
    unique_ips = set()
    total_bytes = 0
    total_reqs = 0
    simulate_calls = 0
    simulate_4xx = 0
    simulate_5xx = 0

    files = sorted(Path(log_dir).glob('access.log*'))
    for f in files:
        for line in read_lines(f):
            m = LOG_RE.match(line)
            if not m:
                continue
            try:
                ts = dt.datetime.strptime(m.group('ts'), '%d/%b/%Y:%H:%M:%S %z').astimezone(dt.timezone.utc)
            except Exception:
                continue
            if ts < cutoff:
                continue

            total_reqs += 1
            ip = m.group('ip')
            status = m.group('status')
            body = m.group('body')
            req = m.group('req')
            referer = (m.group('referer') or '').strip()
            ua = (m.group('ua') or '').strip()

            unique_ips.add(ip)
            ip_counter[ip] += 1
            status_counter[status] += 1
            try:
                if body != '-':
                    total_bytes += int(body)
            except Exception:
                pass

            parts = req.split()
            method = parts[0].upper() if len(parts) >= 2 else ''
            path = parts[1] if len(parts) >= 2 else req
            path = _normalize_path(path)
            if method:
                method_counter[method] += 1
            path_counter[path] += 1
            if path.startswith('/api/') or path.startswith('/simulate') or path.startswith('/api/simulate'):
                api_path_counter[path] += 1

            if referer and referer != '-':
                referer_full_counter[referer] += 1
                referer_domain_counter[_domain_from_url(referer)] += 1

            if ua and ua != '-':
                ua_counter[ua] += 1

            if path.startswith('/api/simulate') or path.startswith('/simulate'):
                if method == 'POST' or method == '':
                    simulate_calls += 1
                    if status.startswith('4'):
                        simulate_4xx += 1
                    elif status.startswith('5'):
                        simulate_5xx += 1

    s2xx = sum(v for k, v in status_counter.items() if k.startswith('2'))
    s3xx = sum(v for k, v in status_counter.items() if k.startswith('3'))
    s4xx = sum(v for k, v in status_counter.items() if k.startswith('4'))
    s5xx = sum(v for k, v in status_counter.items() if k.startswith('5'))

    return {
        'hours': float(hours),
        'total_reqs': total_reqs,
        'unique_ips': len(unique_ips),
        'total_bytes': total_bytes,
        's2xx': s2xx,
        's3xx': s3xx,
        's4xx': s4xx,
        's5xx': s5xx,
        'top_ips': ip_counter.most_common(10),
        'top_paths': path_counter.most_common(10),
        'top_api_paths': api_path_counter.most_common(10),
        'top_referer_domains': referer_domain_counter.most_common(10),
        'top_referers': referer_full_counter.most_common(10),
        'top_user_agents': ua_counter.most_common(8),
        'methods': method_counter.most_common(10),
        'simulate_calls': simulate_calls,
        'simulate_4xx': simulate_4xx,
        'simulate_5xx': simulate_5xx,
    }


def build_report_text(stats, geo: dict | None = None):
    now = dt.datetime.now(dt.timezone.utc)
    host = socket.gethostname()

    try:
        load1, load5, load15 = os.getloadavg()
    except Exception:
        load1 = load5 = load15 = 0.0
    cpu = get_cpu_percent()
    mem_total, mem_used, mem_avail = get_meminfo()
    try:
        disk_total, disk_used, disk_free = shutil.disk_usage('/')
    except Exception:
        disk_total = disk_used = disk_free = 0

    uptime_sec = 0
    try:
        with open('/proc/uptime', 'r', encoding='utf-8') as f:
            uptime_sec = int(float(f.read().split()[0]))
    except Exception:
        pass
    up_h = uptime_sec // 3600
    up_m = (uptime_sec % 3600) // 60

    lines = []
    lines.append('PlasmaCCP Daily Server Report')
    lines.append(f'Host: {host}')
    lines.append(f'Generated (UTC): {now.strftime("%Y-%m-%d %H:%M:%S")}')
    lines.append('')
    lines.append('[System]')
    lines.append(f'Uptime: {up_h}h {up_m}m')
    lines.append(f'Load avg (1/5/15m): {load1:.2f} / {load5:.2f} / {load15:.2f}')
    lines.append(f'CPU usage (~0.8s sample): {cpu:.1f}%' if cpu is not None else 'CPU usage: n/a')
    lines.append(f'Memory: used {human_bytes(mem_used)} / total {human_bytes(mem_total)} (avail {human_bytes(mem_avail)})')
    lines.append(f'Disk (/): used {human_bytes(disk_used)} / total {human_bytes(disk_total)} (free {human_bytes(disk_free)})')
    lines.append('')
    hours = stats.get('hours', 24.0)
    lines.append(f'[Nginx traffic - last {hours:.0f}h]')
    lines.append(f'Total requests: {stats["total_reqs"]}')
    lines.append(f'Unique IPs (approx visitors): {stats.get("unique_ips", 0)}')
    lines.append(f'Total response bytes: {human_bytes(stats["total_bytes"])}')
    lines.append(f'Status: 2xx={stats["s2xx"]}, 3xx={stats["s3xx"]}, 4xx={stats["s4xx"]}, 5xx={stats["s5xx"]}')
    if stats.get('methods'):
        lines.append('Methods: ' + ', '.join(f'{m}={c}' for m, c in stats['methods']))
    if stats.get('simulate_calls', 0):
        lines.append(
            f'Simulate calls (POST /simulate): {stats.get("simulate_calls", 0)} '
            f'(4xx={stats.get("simulate_4xx", 0)}, 5xx={stats.get("simulate_5xx", 0)})'
        )
    lines.append('')
    lines.append('Top IPs:')
    if stats['top_ips']:
        for ip, cnt in stats['top_ips']:
            label = ip
            if geo and ip in geo and geo[ip]:
                g = geo[ip]
                parts = [p for p in [g.get('country_code'), g.get('country'), g.get('city'), g.get('org')] if p]
                if parts:
                    label = f'{ip} ({", ".join(parts)})'
            lines.append(f'- {label}: {cnt}')
    else:
        lines.append('- (no data)')

    if geo and stats.get('top_ips'):
        country_counter = Counter()
        for ip, cnt in stats['top_ips']:
            g = geo.get(ip) if isinstance(geo, dict) else None
            if not g:
                continue
            cc = (g.get('country_code') or g.get('country') or '').strip() or None
            if cc:
                country_counter[cc] += int(cnt)
        if country_counter:
            lines.append('')
            lines.append('Top Geo (top IPs only):')
            for cc, cnt in country_counter.most_common(10):
                lines.append(f'- {cc}: {cnt}')
    lines.append('')
    lines.append('Top Paths:')
    if stats['top_paths']:
        for path, cnt in stats['top_paths']:
            lines.append(f'- {path}: {cnt}')
    else:
        lines.append('- (no data)')

    if stats.get('top_api_paths'):
        lines.append('')
        lines.append('Top API Paths:')
        for path, cnt in stats['top_api_paths']:
            lines.append(f'- {path}: {cnt}')

    if stats.get('top_referer_domains'):
        lines.append('')
        lines.append('Top Referrer Domains:')
        for dom, cnt in stats['top_referer_domains']:
            lines.append(f'- {dom}: {cnt}')

    if stats.get('top_referers'):
        lines.append('')
        lines.append('Top Referrers (full):')
        for ref, cnt in stats['top_referers']:
            lines.append(f'- {_safe_trunc(ref, 140)}: {cnt}')

    if stats.get('top_user_agents'):
        lines.append('')
        lines.append('Top User-Agents:')
        for ua, cnt in stats['top_user_agents']:
            lines.append(f'- {_safe_trunc(ua, 140)}: {cnt}')
    return '\n'.join(lines)


def send_mail(subject: str, body: str, sender: str, password: str, recipient: str):
    msg = EmailMessage()
    msg['From'] = sender
    msg['To'] = recipient
    msg['Subject'] = subject
    msg.set_content(body)

    with smtplib.SMTP_SSL('smtp.gmail.com', 465, timeout=30) as s:
        s.login(sender, password)
        s.send_message(msg)


def main():
    env = parse_env(DEFAULT_ENV_PATH)
    sender = env.get('SMTP_SENDER', '').strip()
    password = env.get('SMTP_APP_PASSWORD', '').strip()
    recipient = env.get('REPORT_TO', '').strip()

    if not sender or not password or not recipient:
        raise SystemExit(f'Missing SMTP_SENDER / SMTP_APP_PASSWORD / REPORT_TO in {DEFAULT_ENV_PATH}')

    hours = float(env.get('REPORT_HOURS', '24') or '24')
    stats = parse_nginx_last_hours(hours=hours)

    geo_by_ip = None
    if _as_bool(env.get('ENABLE_GEOIP', '0')):
        provider = env.get('GEO_PROVIDER', 'ipapi')
        timeout_sec = float(env.get('GEO_TIMEOUT_SEC', '2.0') or '2.0')
        cache_path = Path(env.get('GEO_CACHE_PATH', str(DEFAULT_GEO_CACHE_PATH)))
        cache = _load_json(cache_path)
        geo_by_ip = {}
        # Only look up a small set of "top" IPs to avoid rate limits.
        for ip, _cnt in (stats.get('top_ips') or [])[:10]:
            if not is_public_ip(ip):
                continue
            if ip in cache and isinstance(cache.get(ip), dict):
                geo_by_ip[ip] = cache.get(ip)
                continue
            g = geo_lookup(ip, provider=provider, timeout_sec=timeout_sec)
            if g:
                geo_by_ip[ip] = g
                cache[ip] = g
        _write_json(cache_path, cache)

    body = build_report_text(stats, geo=geo_by_ip)
    subject = f"[PlasmaCCP] Daily server report ({dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%d')})"
    send_mail(subject, body, sender, password, recipient)


if __name__ == '__main__':
    main()
