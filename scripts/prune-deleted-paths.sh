#!/usr/bin/env bash
# Убирает из целевого дерева (прод при выкатке) файлы, которые удалены между
# двумя коммитами. Выкатка копирует файлы через rsync без --delete и делает
# `git reset --mixed`, поэтому удалённые в ветке исходники остаются в проде
# неотслеживаемыми и ломают следующую сборку там (TS2307 и т. п.).
#
#   bash scripts/prune-deleted-paths.sh --repo <git> --target <дерево> \
#     --from <база> --to <новый коммит> [--backup <файл.tar>] [--apply]
#
# Без --apply только печатает план. Файл удаляется, только если он побайтно
# совпадает с версией из --from: правленый на месте файл не трогаем, а
# завершаемся с кодом 1, чтобы выкатку остановили и разобрались руками.
# --backup до удаления складывает удаляемые файлы в tar (пути от --target).
# Опустевшие после удаления каталоги тоже убираются.
set -euo pipefail

REPO=""
TARGET=""
FROM=""
TO=""
BACKUP=""
APPLY=0

die() { printf 'prune-deleted-paths: %s\n' "$*" >&2; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --target) TARGET="${2:-}"; shift 2 ;;
    --from) FROM="${2:-}"; shift 2 ;;
    --to) TO="${2:-}"; shift 2 ;;
    --backup) BACKUP="${2:-}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) die "неизвестный параметр: $1" ;;
  esac
done

[[ -n "$REPO" && -n "$TARGET" && -n "$FROM" && -n "$TO" ]] ||
  die "нужны --repo, --target, --from и --to"
[[ -d "$TARGET" ]] || die "нет каталога $TARGET"
TARGET="$(cd "$TARGET" && pwd -P)"
git -C "$REPO" rev-parse --verify --quiet "$FROM^{commit}" >/dev/null || die "нет коммита $FROM"
git -C "$REPO" rev-parse --verify --quiet "$TO^{commit}" >/dev/null || die "нет коммита $TO"

remove=()
changed=0
while IFS= read -r -d '' rel; do
  case "$rel" in
    /*|..|../*|*/../*|*/..) die "подозрительный путь из git: $rel" ;;
  esac
  file="$TARGET/$rel"
  if [[ ! -e "$file" && ! -L "$file" ]]; then
    printf 'уже нет: %s\n' "$rel"
    continue
  fi
  want="$(git -C "$REPO" rev-parse "$FROM:$rel")"
  if [[ -L "$file" ]]; then
    have="$(printf '%s' "$(readlink "$file")" | git -C "$REPO" hash-object --stdin)"
  elif [[ -f "$file" ]]; then
    have="$(git -C "$REPO" hash-object --no-filters -- "$file")"
  else
    have="не файл"
  fi
  if [[ "$have" != "$want" ]]; then
    printf 'ИЗМЕНЁН, не трогаю: %s\n' "$rel"
    changed=1
    continue
  fi
  printf 'удалить: %s\n' "$rel"
  remove+=("$rel")
done < <(git -C "$REPO" diff --no-renames --diff-filter=D --name-only -z "$FROM" "$TO")

if [[ "$changed" == "1" ]]; then
  printf 'Есть изменённые на месте файлы — ничего не удалено.\n' >&2
  exit 1
fi
if [[ "$APPLY" != "1" ]]; then
  printf 'План: %d файл(ов). Для удаления добавь --apply.\n' "${#remove[@]}"
  exit 0
fi
if [[ "${#remove[@]}" -eq 0 ]]; then
  printf 'Удалять нечего.\n'
  exit 0
fi
if [[ -n "$BACKUP" ]]; then
  [[ ! -e "$BACKUP" ]] || die "$BACKUP уже есть"
  tar -cf "$BACKUP" -C "$TARGET" -- "${remove[@]}"
  printf 'Копия: %s\n' "$BACKUP"
fi
for rel in "${remove[@]}"; do
  rm -f -- "$TARGET/$rel"
  dir="$(dirname "$rel")"
  while [[ "$dir" != "." ]]; do
    rmdir -- "$TARGET/$dir" 2>/dev/null || break
    dir="$(dirname "$dir")"
  done
done
printf 'Удалено: %d файл(ов).\n' "${#remove[@]}"
