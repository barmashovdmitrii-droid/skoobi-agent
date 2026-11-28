#!/usr/bin/env bash
# Создаёт venv для голоса Edge (Python edge-tts) с закреплёнными версиями из
# scripts/edge-tts-requirements.txt. Только явный запуск оператором: бот сам
# ничего не ставит и не скачивает.
#
#   bash scripts/setup-edge-tts.sh                 # .runtime/edge-tts/venv, если его ещё нет
#   bash scripts/setup-edge-tts.sh --replace       # пересоздать; старый venv -> venv.bak-<время>
#   bash scripts/setup-edge-tts.sh --venv <путь>   # другой каталог
#   bash scripts/setup-edge-tts.sh --python <путь> # конкретный Python (не старше 3.10)
#
# Новый venv собирается рядом, проверяется импортом и только потом встаёт на
# место, так что работающий голос не пропадает, если установка сорвалась.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REQUIREMENTS="$ROOT/scripts/edge-tts-requirements.txt"
VENV="$ROOT/.runtime/edge-tts/venv"
PYTHON=""
REPLACE=0

die() { printf 'setup-edge-tts: %s\n' "$*" >&2; exit 2; }

# CommandLineTools даёт Python 3.9 (поддержка закончилась в 10.2025) —
# такой не берём.
python_is_supported() {
  local python="$1"
  [[ -x "$python" ]] || command -v "$python" >/dev/null 2>&1 || return 1
  "$python" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1
}

pick_python() {
  local candidate
  for candidate in \
    /opt/homebrew/bin/python3.13 /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.11 \
    /usr/local/bin/python3.13 /usr/local/bin/python3.12 /usr/local/bin/python3.11 \
    python3.13 python3.12 python3.11 python3.10 python3; do
    if python_is_supported "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --venv) VENV="${2:-}"; [[ -n "$VENV" ]] || die "--venv требует путь"; shift 2 ;;
    --python) PYTHON="${2:-}"; [[ -n "$PYTHON" ]] || die "--python требует путь"; shift 2 ;;
    --replace) REPLACE=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) die "неизвестный параметр: $1" ;;
  esac
done

if [[ -e "$VENV" || -L "$VENV" ]] && [[ "$REPLACE" != "1" ]]; then
  die "$VENV уже есть; чтобы пересоздать, добавь --replace (старый сохранится рядом)"
fi
[[ -f "$REQUIREMENTS" ]] || die "нет $REQUIREMENTS"

if [[ -z "$PYTHON" ]]; then
  PYTHON="$(pick_python)" || die "нужен Python 3.10 или новее (brew install python@3.13)"
elif ! python_is_supported "$PYTHON"; then
  die "$PYTHON не подходит: нужен Python 3.10 или новее"
fi

parent="$(dirname "$VENV")"
mkdir -p "$parent"
stage="$(mktemp -d "$parent/.edge-tts-venv.XXXXXX")"
trap 'rm -rf "$stage"' EXIT

printf 'Python: %s (%s)\n' "$PYTHON" "$("$PYTHON" -c 'import sys; print(sys.version.split()[0])')"

# venv хранит абсолютные пути: переносить готовый каталог нельзя, поэтому
# после проверки создаём его заново прямо на месте (пакеты pip берёт уже из
# своего кеша). Если не вышло — возвращаем старый venv.
build_venv() {
  local target="$1"
  "$PYTHON" -m venv "$target" &&
    "$target/bin/python" -m pip --isolated --disable-pip-version-check install \
      --only-binary=:all: --no-deps --require-virtualenv -r "$REQUIREMENTS" &&
    "$target/bin/python" -c 'import edge_tts, edge_tts.communicate
from edge_tts.constants import TRUSTED_CLIENT_TOKEN'
}

# Сначала пробная сборка рядом: работающий голос не трогаем, пока не ясно,
# что пакеты скачиваются и импортируются.
build_venv "$stage/venv" || die "пробная сборка не удалась; $VENV не тронут"

backup=""
if [[ -e "$VENV" || -L "$VENV" ]]; then
  backup="$VENV.bak-$(date +%Y%m%d-%H%M%S)"
  mv "$VENV" "$backup"
fi
if ! build_venv "$VENV"; then
  rm -rf "$VENV"
  if [[ -n "$backup" ]]; then
    mv "$backup" "$VENV"
    die "не получилось; старый venv возвращён на место"
  fi
  die "не получилось создать $VENV"
fi
[[ -z "$backup" ]] || printf 'Старый venv сохранён: %s\n' "$backup"
printf 'Готово: %s\n' "$VENV"
# Бот по умолчанию ищет venv и адаптер от своего рабочего каталога. При
# установке через install.sh служба работает из каталога инстанса, а не
# отсюда, — тогда эти две строки должны быть в .env инстанса (install.sh
# прописывает их сам, если их там ещё нет).
printf 'Если служба запускается не из %s, в .env инстанса нужны строки:\n' "$ROOT"
printf '  EDGE_TTS_BIN="%s/bin/python"\n' "$(cd "$VENV" && pwd -P)"
printf '  EDGE_TTS_SCRIPT="%s/scripts/edge-tts-adapter.py"\n' "$ROOT"
