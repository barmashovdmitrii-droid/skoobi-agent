/**
 * Что из навыка на самом деле попадает в ход.
 *
 * Бот подставляет в ход не весь SKILL.md, а окно — первые 1800 знаков файла
 * вместе с frontmatter (skillPromptWindow в skill-registry). Правило, которое
 * оказалось за окном, модель видит, только если сама откроет навык. Скрипт
 * показывает заполнение окна у каждого навыка и, для одного навыка, прогоняет
 * настоящую подстановку (buildSkillPromptContext: выбор по триггерам, окно,
 * экранирование) и проверяет, что каждая нужная фраза есть в окне.
 *
 * Только чтение: навыки копируются во временную папку, поэтому счётчики
 * .usage.json в настоящей папке не меняются. Навык-симлинк и SKILL.md-симлинк
 * пропускаются, как в самом реестре. Хостовые проверки навыков
 * (~/.skoobi-host-checks) этого Скуби только читаются: навык, которому нужна
 * проверка, показан и выбран так же, как его выберет бот.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildSkillPromptContext,
  DEFAULT_MAX_SKILL_CHARS,
  defaultSkillsDir,
  defaultSkillVerificationHost,
  isSafeSkillName,
  listSkills,
  SKILL_FILE_NAME,
  skillPromptWindow,
} from '../orchestrator/skill-registry.js';
import type { ArtifactAcceptanceHost } from '@skoobi/core/artifact-acceptance';

export interface SkillWindowRow {
  name: string;
  status: string;
  /** Длина всего SKILL.md в знаках String.length. */
  fileChars: number;
  /** Сколько знаков окна занимает frontmatter (0 без frontmatter). */
  frontmatterChars: number;
  limit: number;
  truncated: boolean;
  /** Сколько знаков файла за окном. */
  lostChars: number;
}

export interface SkillWindowCheck {
  name: string;
  text: string;
  folder: string;
  chatJid: string;
  /** Навыки, выбранные на этот текст, в порядке подстановки. */
  selectedSkills: string[];
  selected: boolean;
  /** Окно навыка из готового контекста хода, без XML-экранирования. */
  window: string;
  present: string[];
  missing: string[];
  ok: boolean;
}

export interface SkillWindowReport {
  skillsDir: string;
  limit: number;
  rows: SkillWindowRow[];
  check?: SkillWindowCheck;
}

export interface SkillWindowInput {
  skillsDir: string;
  /**
   * Корень Скуби, чьи хостовые проверки навыков учитывать. По умолчанию —
   * <корень>, если папка навыков — <корень>/data/skills.
   */
  instanceRoot?: string;
  /** Хранилище проверок навыков вместо хостового (для тестов). */
  verificationHost?: ArtifactAcceptanceHost;
  maxChars?: number;
  skill?: string;
  text?: string;
  folder?: string;
  chatJid?: string;
  require?: string[];
}

function frontmatterChars(markdown: string): number {
  if (!markdown.startsWith('---\n')) return 0;
  const end = markdown.indexOf('\n---', 4);
  return end < 0 ? 0 : end + '\n---'.length;
}

/** Копия SKILL.md всех навыков без перехода по симлинкам. */
function copySkillFiles(source: string, target: string): void {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(source, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // Dirent от readdir — это lstat: симлинк на папку сюда не проходит.
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (!isSafeSkillName(entry.name)) continue;
    const file = path.join(source, entry.name, SKILL_FILE_NAME);
    let markdown: string;
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      if (!fs.fstatSync(fd).isFile()) continue;
      markdown = fs.readFileSync(fd, 'utf8');
    } catch {
      continue;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
    const dir = path.join(target, entry.name);
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, SKILL_FILE_NAME), markdown, { mode: 0o600 });
  }
}

function instanceRootOf(skillsDir: string): string | undefined {
  const data = path.dirname(skillsDir);
  return path.basename(skillsDir) === 'skills' && path.basename(data) === 'data'
    ? path.dirname(data)
    : undefined;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function skillBlock(context: string, name: string): string | null {
  const open = context.indexOf(`<skill name="${name}" `);
  if (open < 0) return null;
  const start = context.indexOf('\n', open) + 1;
  const end = context.indexOf('\n</skill>', start);
  if (start <= 0 || end < 0) return null;
  return unescapeXml(context.slice(start, end));
}

export function inspectSkillWindows(input: SkillWindowInput): SkillWindowReport {
  const limit = skillPromptWindow('', input.maxChars ?? DEFAULT_MAX_SKILL_CHARS)
    .limit;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-skills-window-'));
  try {
    const skillsDir = path.join(temp, 'skills');
    copySkillFiles(input.skillsDir, skillsDir);
    const instanceRoot = input.instanceRoot ?? instanceRootOf(input.skillsDir);
    // Проверки навыков только читаются (listSkills/selectSkills ничего туда не
    // пишут). Без корня Скуби — пустое хранилище во временной папке.
    const stateDir = path.join(temp, 'host-state');
    const verificationHost: ArtifactAcceptanceHost =
      input.verificationHost ??
      (instanceRoot && fs.existsSync(instanceRoot)
        ? defaultSkillVerificationHost(skillsDir, instanceRoot)
        : {
            stateDir,
            agentWritableRoots: [skillsDir],
            checkerPath: path.join(stateDir, 'checker.mjs'),
            boundary: 'owner-full-access',
          });
    const summaries = listSkills({
      skillsDir,
      includeDraft: true,
      verificationHost,
    });
    const rows = summaries.map((skill): SkillWindowRow => {
      const markdown = fs.readFileSync(skill.path, 'utf8');
      const window = skillPromptWindow(markdown, limit);
      return {
        name: skill.name,
        status: skill.status,
        fileChars: window.fileChars,
        frontmatterChars: frontmatterChars(markdown),
        limit: window.limit,
        truncated: window.truncated,
        lostChars: Math.max(0, window.fileChars - window.limit),
      };
    });
    const report: SkillWindowReport = {
      skillsDir: input.skillsDir,
      limit,
      rows,
    };
    if (!input.skill) return report;

    const summary = summaries.find((skill) => skill.name === input.skill);
    if (!summary) {
      throw new Error(`Навык не найден: ${input.skill}`);
    }
    const text = input.text ?? summary.triggers[0];
    if (!text) {
      throw new Error(`У навыка ${summary.name} нет триггеров: укажи --text`);
    }
    const folder = input.folder ?? summary.folders[0] ?? 'telegram_main';
    const chatJid = input.chatJid ?? `${summary.channels[0] ?? 'tg'}:0`;
    const result = buildSkillPromptContext({
      text,
      chatJid,
      group: {
        name: folder,
        folder,
        trigger: '@Skoobi',
        added_at: new Date(0).toISOString(),
        requiresTrigger: false,
        isMain: true,
      },
      skillsDir,
      maxSkillChars: limit,
      verificationHost,
    });
    const selectedSkills = result.selected.map((skill) => skill.name);
    const window = skillBlock(result.context, summary.name) ?? '';
    const required = input.require ?? [];
    const present = required.filter((phrase) => window.includes(phrase));
    const missing = required.filter((phrase) => !window.includes(phrase));
    const selected = selectedSkills.includes(summary.name);
    report.check = {
      name: summary.name,
      text,
      folder,
      chatJid,
      selectedSkills,
      selected,
      window,
      present,
      missing,
      ok: selected && missing.length === 0,
    };
    return report;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

type Args = SkillWindowInput & {
  show: boolean;
  json: boolean;
  help: boolean;
};

function usageText(): string {
  return [
    'Usage: skoobi-skills-window [options]',
    '',
    'Показывает, сколько от каждого навыка попадает в ход (окно — первые',
    `${DEFAULT_MAX_SKILL_CHARS} знаков файла вместе с frontmatter). С --skill прогоняет`,
    'настоящую подстановку и проверяет, что фразы --require есть в окне.',
    'Только чтение: навыки копируются во временную папку.',
    '',
    'Options:',
    '  --root <path>        Корень Скуби (по умолчанию cwd)',
    '  --skills-dir <path>  Папка навыков (по умолчанию <root>/data/skills)',
    '  --max-chars <n>      Размер окна (по умолчанию как у бота)',
    '  --skill <name>       Проверить окно одного навыка',
    '  --text <message>     Сообщение для выбора навыка (по умолчанию первый триггер)',
    '  --folder <folder>    Папка чата (по умолчанию первая из folders навыка)',
    '  --chat <jid>         Чат (по умолчанию <первый канал навыка>:0)',
    '  --require <phrase>   Фраза, которая должна быть в окне (можно несколько)',
    '  --show               Напечатать окно навыка',
    '  --json               JSON вместо текста',
    '  --help               Эта справка',
    '',
    'Код выхода 1, если навык не выбран или какой-то фразы нет в окне.',
  ].join('\n');
}

function parseArgs(argv: string[]): Args {
  const root = process.cwd();
  const args: Args = {
    skillsDir: defaultSkillsDir(path.join(root, 'data')),
    require: [],
    show: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    if (arg === '--root') {
      args.instanceRoot = path.resolve(next());
      args.skillsDir = defaultSkillsDir(path.join(args.instanceRoot, 'data'));
    } else if (arg === '--skills-dir') args.skillsDir = path.resolve(next());
    else if (arg === '--max-chars') {
      const value = Number(next());
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error('--max-chars must be a positive integer');
      }
      args.maxChars = value;
    } else if (arg === '--skill') args.skill = next();
    else if (arg === '--text') args.text = next();
    else if (arg === '--folder') args.folder = next();
    else if (arg === '--chat') args.chatJid = next();
    else if (arg === '--require') args.require!.push(next());
    else if (arg === '--show') args.show = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return args;
}

export function formatSkillWindowReport(
  report: SkillWindowReport,
  show = false,
): string {
  const lines = [
    `Окно навыка: ${report.limit} знаков файла вместе с frontmatter`,
    `skillsDir: ${report.skillsDir}`,
  ];
  for (const row of report.rows) {
    const fill = Math.min(row.fileChars, row.limit);
    lines.push(
      `- ${row.name} [${row.status}]: ${row.fileChars} знаков, frontmatter ${row.frontmatterChars}, в окне ${fill}/${row.limit}` +
        (row.truncated ? `, за окном ${row.lostChars}` : ''),
    );
  }
  const check = report.check;
  if (check) {
    lines.push('');
    lines.push(
      `${check.name}: на «${check.text}» (${check.folder}, ${check.chatJid}) выбраны: ${check.selectedSkills.join(', ') || 'ничего'}`,
    );
    if (!check.selected) lines.push(`НЕ ВЫБРАН: ${check.name}`);
    for (const phrase of check.present) lines.push(`  есть   «${phrase}»`);
    for (const phrase of check.missing) lines.push(`  НЕТ    «${phrase}»`);
    lines.push(
      check.ok
        ? `Итог: все ${check.present.length} фраз в окне`
        : `Итог: проверка не прошла`,
    );
    if (show) {
      lines.push('', '----- окно -----', check.window, '----- конец окна -----');
    }
  }
  return lines.join('\n') + '\n';
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/skills-window.js') ||
  process.argv[1]?.endsWith('/skills-window.ts');

if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(usageText() + '\n');
      process.exit(0);
    }
    const report = inspectSkillWindows(args);
    process.stdout.write(
      args.json
        ? JSON.stringify(report, null, 2) + '\n'
        : formatSkillWindowReport(report, args.show),
    );
    process.exit(report.check && !report.check.ok ? 1 : 0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
