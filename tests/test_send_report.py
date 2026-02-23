import datetime as dt
from pathlib import Path


def _write(p: Path, s: str):
    p.write_text(s, encoding="utf-8")


def test_send_report_parses_combined_log(tmp_path: Path):
    # Import from file path style used in this repo.
    from deploy.ops.send_report import parse_nginx_last_hours

    now = dt.datetime(2026, 2, 10, 0, 0, 0, tzinfo=dt.timezone.utc)
    ts = "10/Feb/2026:00:00:00 +0000"

    # Typical nginx combined format:
    # <ip> - - [ts] "METHOD PATH HTTP/1.1" <status> <bytes> "<referer>" "<ua>"
    lines = [
        f'203.0.113.10 - - [{ts}] "GET / HTTP/1.1" 200 1234 "-" "Mozilla/5.0 (X11; Linux x86_64)"\n',
        f'203.0.113.10 - - [{ts}] "POST /api/simulate?mode=stub HTTP/1.1" 200 567 "-" "curl/8.0"\n',
        f'198.51.100.9 - - [{ts}] "GET /about HTTP/1.1" 404 10 "https://google.com/search?q=plasma" "UA X"\n',
    ]
    _write(tmp_path / "access.log", "".join(lines))

    stats = parse_nginx_last_hours(hours=24, log_dir=tmp_path, now=now)

    assert stats["total_reqs"] == 3
    assert stats["unique_ips"] == 2
    assert stats["s2xx"] == 2
    assert stats["s4xx"] == 1
    assert stats["simulate_calls"] == 1
    assert any(p == "/api/simulate" for p, _ in stats["top_api_paths"])
    assert any(dom == "google.com" for dom, _ in stats["top_referer_domains"])


def test_send_report_parses_short_log_without_referer_ua(tmp_path: Path):
    from deploy.ops.send_report import parse_nginx_last_hours

    now = dt.datetime(2026, 2, 10, 0, 0, 0, tzinfo=dt.timezone.utc)
    ts = "10/Feb/2026:00:00:00 +0000"

    # Some setups log only up to <bytes>.
    lines = [
        f'203.0.113.10 - - [{ts}] "GET / HTTP/1.1" 200 1234\n',
        f'203.0.113.10 - - [{ts}] "GET /x?y=1 HTTP/1.1" 200 1\n',
    ]
    _write(tmp_path / "access.log", "".join(lines))

    stats = parse_nginx_last_hours(hours=24, log_dir=tmp_path, now=now)
    assert stats["total_reqs"] == 2
    # Query string is stripped.
    assert any(p == "/x" for p, _ in stats["top_paths"])

