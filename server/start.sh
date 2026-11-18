#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
#  ماريا — تشغيل المنصة على جهازك (Mac / Linux)
#  الاستعمال:  bash start.sh
# ═══════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"

C_OK=$'\033[1;32m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'; C_OFF=$'\033[0m'
say()  { echo "${C_OK}▸${C_OFF} $*"; }
warn() { echo "${C_WARN}!${C_OFF} $*"; }
die()  { echo "${C_ERR}✗${C_OFF} $*" >&2; exit 1; }

echo
echo "  ═══ ماريا — تشغيل محلي ═══"
echo

# 1) هل Node مثبَّت؟
if ! command -v node >/dev/null 2>&1; then
  die "Node.js غير مثبَّت.
  ثبّته من: https://nodejs.org  (اختر LTS) ثم أعد تشغيل هذا الأمر."
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
say "Node.js: $(node -v)"
[[ "$NODE_MAJOR" -ge 18 ]] || die "تحتاج Node 18 أو أحدث (عندك $(node -v))."

# 2) الحزم
if [[ ! -d node_modules ]]; then
  say "تثبيت الحزم (مرة واحدة، دقيقة تقريبًا)…"
  npm install --no-audit --no-fund
else
  say "الحزم مثبَّتة ✓"
fi

# 3) الإعدادات
[[ -f .env ]] || { [[ -f .env.example ]] && cp .env.example .env && say "أُنشئ .env من المثال"; }

export MARIA_MODE="${MARIA_MODE:-mock}"
export PAYMENT_PROVIDER="${PAYMENT_PROVIDER:-sandbox}"
export MARIA_ADMIN_TOKEN="${MARIA_ADMIN_TOKEN:-dev-admin-token}"
export PORT="${PORT:-4173}"
export PGLITE_DIR="${PGLITE_DIR:-$PWD/data/pglite}"

# 4) التشغيل
echo
say "المنصة تعمل الآن على:  http://localhost:$PORT"
say "لوحة التشغيل:          http://localhost:$PORT/dashboard"
echo "  (أوقفها بـ Ctrl+C)"
echo
exec node src/index.js
