#!/usr/bin/env bash
set -euo pipefail
F=/etc/nginx/sites-available/plasmaccp.com
BAK=/etc/nginx/sites-available/plasmaccp.com.bak.413fix_20260209
if [ -f "$BAK" ]; then
  sudo cp "$BAK" "$F"
fi
if ! sudo grep -q "client_max_body_size" "$F"; then
  sudo awk 'NR==1{print; print "    client_max_body_size 50m;"; next}1' "$F" | sudo tee /tmp/plasmaccp.com.fixed >/dev/null
  sudo mv /tmp/plasmaccp.com.fixed "$F"
fi
sudo nginx -t
sudo systemctl restart nginx
sudo grep -n "client_max_body_size" "$F"
