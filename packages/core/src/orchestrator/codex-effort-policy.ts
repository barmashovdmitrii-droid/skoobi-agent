/**
 * Bounded, deterministic routing for a new host-owned Codex run. This is a
 * heuristic, not a semantic difficulty evaluator. It neither grants tools nor
 * changes a running turn, its model, its speed, or its authorization.
 */
export type CodexAdaptiveEffort = 'xhigh' | 'max' | 'ultra';

export interface CodexEffortHistoryMessage {
  text: string;
  timestamp: string | number;
  senderId: string;
}

export interface CodexEffortPolicyInput {
  /** Current direct-owner bodies only, never the assembled model prompt. */
  text: string;
  trustedOwner: boolean;
  restricted: boolean;
  enabled: boolean;
  /** Verified owner messages, oldest first; no assistant or background output. */
  history?: readonly CodexEffortHistoryMessage[];
  senderId?: string;
  now?: number;
}

export interface CodexEffortDecision {
  effort: CodexAdaptiveEffort;
  /** Stable codes only: never place the task text in routing telemetry. */
  reason: string;
  policyVersion: 1;
  source: 'current' | 'continuation' | 'baseline';
}

const HISTORY_LIMIT = 15;
const HISTORY_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_TEXT_CHARS = 32_000;

function decision(
  effort: CodexAdaptiveEffort,
  reason: string,
  source: CodexEffortDecision['source'] = 'baseline',
): CodexEffortDecision {
  return { effort, reason, policyVersion: 1, source };
}

/** Remove commonplace quoted data before looking for task signals. */
function directTaskText(value: string): string {
  if (typeof value !== 'string' || value.length > MAX_TEXT_CHARS) return '';
  let text = value.trim().replace(/\r\n?/g, '\n');
  if (/^\[(?:voice|audio):/iu.test(text)) {
    if (!text.endsWith(']')) return '';
    text = text.replace(/^\[(?:voice|audio):\s*/iu, '').slice(0, -1);
    if (/\[(?:voice|audio):/iu.test(text)) return '';
  }
  text = text.replace(/&lt;/giu, '<').replace(/&gt;/giu, '>');
  // XML/HTML metadata and quoted blocks are data even when pasted directly.
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  for (let n = 0; n < 4; n += 1) {
    const next = text.replace(
      /<([a-z_][\w:.-]*)\b[^>]*>[\s\S]*?<\/\1\s*>/giu,
      ' ',
    );
    if (next === text) break;
    text = next;
  }
  text = text.replace(/<[a-z_][\w:.-]*\b[^>]*\/>/giu, ' ');
  // An unclosed metadata block must not expose its body to the classifier.
  text = text.replace(/<\/?[a-z_][\w:.-]*\b[\s\S]*$/iu, ' ');
  let fence: string | null = null;
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    const marker = /^\s*(?:[-+*]\s+)?(`{3,}|~{3,})/.exec(line);
    if (marker) {
      const kind = marker[1][0];
      if (fence === null) fence = kind;
      else if (fence === kind) fence = null;
      continue;
    }
    if (fence || /^\s*>|^(?:\t| {4})/.test(line)) continue;
    if (
      /^\s*(?:(?:fwd|fw|forwarded|переслано|цитата|quoted text)\s*:|(?:forwarded|original) message\b|пересланное сообщение\b)/iu.test(line)
    ) break;
    // Plain-text pasted examples introduced by an analysis request are data.
    if (
      /(?:объясни|разбери|проанализируй|explain|analy[sz]e|review).*(?:текст|фрагмент|письмо|сообщение|text|snippet|email|message)\s*:\s*$/iu.test(line)
    ) {
      lines.push(line.replace(/:\s*$/, ''));
      break;
    }
    lines.push(line);
  }
  if (fence !== null) return '';
  text = lines.join('\n');
  // A stray inline-code delimiter is ambiguous: do not route from it.
  text = text.replace(/`+[^`\n]*`+/g, ' ');
  if (text.includes('`')) return '';
  return text
    .replace(/«[^»]*»|“[^”]*”|"[^"\n]*"|(?<![\p{L}\p{N}_])'[^'\n]+'(?![\p{L}\p{N}_])/gu, ' ')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

const CANCEL_OR_END = /(?:^|[\s,;.!?])(?:стоп|отмена|отмени|отменяю|не надо|не нужно|закончили|закрыли|задача закрыта|все готово|все сделано|cancel|stop|task completed|task finished)(?:$|[\s,;.!?])/iu;
const NEW_TOPIC = /^(?:а\s+)?(?:теперь (?:другая|новая) (?:задача|тема)|другая задача|новая тема|сменим тему|new task|new topic|switch (?:the )?topic)(?![\p{L}\p{N}_])/iu;
const SHORT_CONTINUATION = /^(?:(?:да|ну|yes|ok)[, ]+)?(?:делай(?: сам)?|сделай(?: сам)?|продолжай|продолжим|доделай|давай|да|поехали|ок(?:ей)?|хорошо|go ahead|continue|yes|do it|proceed)(?:[, ]+пожалуйста|[, ]+please)?[.!?, ]*$/iu;

function isContinuation(text: string): boolean {
  return text.length <= 160 && SHORT_CONTINUATION.test(text);
}

const LEVEL_COMMAND = /(?<![\p{L}\p{N}_])(?:используй|применяй|включи|выбери|работай|переключись|переключи|поставь|use|enable|switch|set)\s+([^.;!?\n]{0,85}?)(x[\s-]?(?:high|хай)|extra\s+high|max|макс(?:имум)?|ultra|ультра)(?![\p{L}\p{N}_])/giu;
const NEGATION_BEFORE_COMMAND = /(?:^|[\s,])(?:не|never|don't|do not|not)\s*(?:(?:пока|вообще|please|ever|yet)\s*)?$/iu;
const NEGATION_IN_COMMAND = /(?:^|\s)(?:не|без|not|no|never)(?:\s|$)/iu;
const LEVEL_DISCUSSION = /^(?:(?:скуби|пожалуйста|please)[, ]+)*(?:объясни|расскажи|сравни|что|как|какой|когда|зачем|почему|можно ли|нужно ли|стоит ли|which|what|how|when|why|should|can|could|would|explain|describe|compare)(?:\s|:)/iu;

function explicitLevel(text: string): {
  selected?: CodexAdaptiveEffort;
  banned: Set<CodexAdaptiveEffort>;
} {
  let selected: CodexAdaptiveEffort | undefined;
  const banned = new Set<CodexAdaptiveEffort>();
  for (const match of text.matchAll(LEVEL_COMMAND)) {
    const clauseStart = Math.max(...['.', ';', '!', '?', '\n'].map((separator) => text.lastIndexOf(separator, match.index! - 1))) + 1;
    if (LEVEL_DISCUSSION.test(text.slice(clauseStart, match.index).trimStart())) continue;
    const label = match[2];
    const effort: CodexAdaptiveEffort = /^(?:ultra|ультра)$/u.test(label)
      ? 'ultra'
      : /^(?:max|макс)/u.test(label) ? 'max' : 'xhigh';
    const before = text.slice(Math.max(0, match.index! - 45), match.index);
    if (NEGATION_BEFORE_COMMAND.test(before) || NEGATION_IN_COMMAND.test(match[1])) {
      banned.add(effort);
      if (selected === effort) selected = undefined;
    } else {
      banned.delete(effort);
      selected = effort;
    }
  }
  return { selected, banned };
}

const ACTION = /(?<![\p{L}\p{N}_])(?:разберись|выясни|найди|исследуй|диагностируй|отладь|исправь|почини|спроектируй|разработай|реализуй|переработай|рефактори|перепиши|создай|сделай|построй|перенеси|мигрируй|проверь|интегрируй|проведи|investigate|diagnose|debug|trace|fix|design|architect|build|create|implement|redesign|rework|refactor|rewrite|migrate|verify|test|integrate|conduct)(?![\p{L}\p{N}_])/giu;
const BUILD_ACTION = /(?<![\p{L}\p{N}_])(?:спроектируй|разработай|реализуй|переработай|рефактори|перепиши|создай|построй|design|architect|build|create|implement|redesign|rework|refactor|rewrite)(?![\p{L}\p{N}_])/iu;
const PROJECT = /(?:систем|crm|приложен|проект|игр[ауыое]|игру|сайт|завод|сервис|программ|платформ|application|project|game|website|system|service|platform|codebase|backend|frontend)/iu;
const VERIFY = /(?:провер|проверь|тест|прохождени|test|validat|verif|regression|end.to.end|playthrough)/iu;
const DIAGNOSIS = /(?:причин|теря[ею]т|гонк|тупик|потер|сбой|сбоя|падает|почему|корнев|race condition|deadlock|data loss|root cause|intermittent|regression|crash|why)/iu;
const STRUCTURAL = /(?:архитектур|рефактор|переработ|перепиши|миграци|перенос|architecture|refactor|redesign|rewrite|migration|distributed)/iu;
const SPLIT_WORK = /(?:отдельно|независим|параллельн|по направлениям|independent|separat|parallel|workstreams?)/iu;
const EXPLICIT_AGENTS = /(?:запусти|подключи|используй|делегируй|spawn|launch|delegate|use)[^.!?\n]{0,85}(?:субагент|агент(?:ов|а|ы)|subagents?|agents?)/iu;
const DIRECTIONS = [
  /(?:механик|геймплей|баланс|gameplay|mechanics|balance)/iu,
  /(?:интерфейс|\bui\b|\bux\b|interface|frontend)/iu,
  /(?:график|визуал|анимаци|модел(?:и|ей)|graphics|visuals|artwork|animations)/iu,
  /(?:звук|музык|аудио|audio|sound|music)/iu,
  /(?:архитектур|backend|\bapi\b|architecture|сервер|server)/iu,
  /(?:безопасност|security|threat)/iu,
  /(?:баз[аыу] данных|схем[ау] данных|database|data migration|миграци)/iu,
  /(?:производительност|оптимизаци|performance|profiling)/iu,
  /(?:документаци|инструкци|documentation|user guide)/iu,
  /(?:тест|проверк|проверь|test|verif|\bqa\b)/iu,
];

function classify(text: string): CodexEffortDecision {
  if (!text) return decision('xhigh', 'no-direct-task');
  if (CANCEL_OR_END.test(text)) return decision('xhigh', 'task-boundary');
  const explicit = explicitLevel(text);
  if (explicit.selected) return decision(explicit.selected, 'explicit-level', 'current');
  // Exclude negated imperative clauses, while keeping diagnostic observations
  // such as "не работает CRM" available as ordinary problem description.
  const workText = text.replace(
    /(?:^|[\s,])(?:не|never|don't|do not)\s+(?:используй|включи|запусти|подключи|делегируй|исправляй|перерабатывай|создавай|use|enable|spawn|launch|delegate|fix|redesign|create)[^.;!?\n]*/giu,
    ' ',
  );
  const actions = new Set([...workText.matchAll(ACTION)].map((match) => match[0]));
  if (actions.size === 0) return decision('xhigh', 'routine');
  const project = PROJECT.test(workText);
  const construction = BUILD_ACTION.test(workText);
  const verified = VERIFY.test(workText);
  const diagnosis = DIAGNOSIS.test(workText);
  const structural = project && STRUCTURAL.test(workText);
  const difficult = verified && (diagnosis || structural) &&
    (actions.size >= 2 || construction || /разберись|diagnose|debug|investigate/iu.test(workText));
  const directionCount = DIRECTIONS.filter((pattern) => pattern.test(workText)).length;
  const largeBuild = project && construction && verified;
  const parallelBuild = largeBuild && SPLIT_WORK.test(workText) && directionCount >= 3;
  const agentBuild = (difficult || largeBuild) && EXPLICIT_AGENTS.test(workText) && directionCount >= 2;
  if ((parallelBuild || agentBuild) && !explicit.banned.has('ultra')) {
    return decision('ultra', 'complex-parallel-work', 'current');
  }
  if (difficult && !explicit.banned.has('max')) {
    return decision('max', 'complex-verified-work', 'current');
  }
  return decision('xhigh', 'routine');
}

export function resolveCodexEffortPolicy(
  input: CodexEffortPolicyInput,
): CodexEffortDecision | undefined {
  if (!input.enabled || !input.trustedOwner) return undefined;
  if (input.restricted) return decision('xhigh', 'restricted-owner');
  const text = directTaskText(input.text);
  if (!isContinuation(text)) return classify(text);
  const now = input.now ?? Date.now();
  if (!input.senderId || !Number.isFinite(now)) {
    return decision('xhigh', 'continuation-without-anchor');
  }
  let before = now;
  for (const item of [...(input.history ?? [])].slice(-HISTORY_LIMIT).reverse()) {
    const at = typeof item.timestamp === 'number' ? item.timestamp : Date.parse(item.timestamp);
    if (item.senderId !== input.senderId || !Number.isFinite(at) || at > before || now - at > HISTORY_AGE_MS) {
      return decision('xhigh', 'continuation-boundary');
    }
    before = at;
    const previous = directTaskText(item.text);
    if (!previous || CANCEL_OR_END.test(previous) || NEW_TOPIC.test(previous)) {
      return decision('xhigh', 'continuation-boundary');
    }
    if (isContinuation(previous)) continue;
    const selected = classify(previous);
    if (selected.source === 'baseline') return decision('xhigh', 'continuation-routine');
    return { ...selected, source: 'continuation', reason: `continuation-${selected.reason}` };
  }
  return decision('xhigh', 'continuation-without-anchor');
}
