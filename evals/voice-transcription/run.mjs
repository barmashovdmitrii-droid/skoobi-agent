// Build the workspace, then run WHISPER_MODEL=/path/to/model.bin node evals/voice-transcription/run.mjs [case ...].
// Uses local Russian speech synthesis on macOS, whisper.cpp, and ffmpeg. Only synthetic audio is evaluated.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cases = [
  {
    tag: 'recipient',
    text: 'Редактор, подготовь отчёт для группы.',
    slots: [/редактор/, /подготовь/, /для группы/],
  },
  {
    tag: 'platform',
    text: 'Собери игру для Роблокс. Проверь вход второго игрока.',
    slots: [/собери/, /роблокс|roblox/, /вход второго игрока/],
  },
  {
    tag: 'cancel',
    text: 'Стоп. Не отправляй архив. Сначала покажи результат мне.',
    slots: [/стоп/, /не отправляй/, /сначала покажи/],
  },
  {
    tag: 'correction',
    text: 'Поправка. Замени пятницу на среду. Остальное оставь.',
    slots: [/замени пятницу на среду/, /остальное оставь/],
  },
  {
    tag: 'version',
    text: 'Возьми версию три, а версию два оставь в архиве.',
    slots: [/возьми версию (три|3)/, /версию (два|2) оставь/],
  },
  {
    tag: 'negative-control',
    text: 'Отправь только черновик, а полный отчёт пока не отправляй.',
    slots: [/отправь только черновик/, /полный отчет пока не отправляй/],
  },
  {
    tag: 'game-review',
    text: 'Перед публикацией на Яндекс Играх проверь звук в меню.',
    slots: [/перед публикацией/, /яндекс играх/, /проверь звук/],
  },
  {
    tag: 'call-cancel',
    call: true,
    text: 'Останови сборку. Не загружай игру на площадку.',
    slots: [/останови сборку/, /не загружай игру/, /на площадку/],
  },
  {
    tag: 'call-roles',
    call: true,
    text: 'Дизайнер проверит меню, а режиссёр проверит звук.',
    slots: [/дизайнер проверит меню/, /режиссер проверит звук/],
  },
  {
    tag: 'call-correction',
    call: true,
    text: 'Нет, исправление. Перенеси встречу с четверга на вторник.',
    slots: [/нет исправление/, /с четверга на вторник/],
  },
  {
    tag: 'heldout-schedule',
    call: true,
    text: 'Поправка к расписанию. Поставь экскурсию не на среду, а на субботу.',
    slots: [/поправка к расписанию/, /не на среду/, /а на субботу/],
  },
  {
    tag: 'heldout-narration',
    call: true,
    text: 'В прошлую пятницу мы проверили все уровни игры.',
    slots: [/прошлую пятницу/, /проверили все уровни/],
  },
  {
    tag: 'reviewer',
    text: 'Редактор проверит сборку. Оставь решение по выпуску мне.',
    slots: [/редактор проверит/, /оставь решение по выпуску мне/],
  },
];
const words = (s) =>
  s
    .toLowerCase()
    .replaceAll('ё', 'е')
    .match(/[\p{L}\p{N}]+/gu) || [];
function wordEdits(expected, actual) {
  let row = Array.from({ length: actual.length + 1 }, (_, i) => i);
  for (const [i, word] of expected.entries()) {
    const next = [i + 1];
    for (const [j, other] of actual.entries())
      next.push(
        Math.min(
          next[j] + 1,
          row[j + 1] + 1,
          row[j] + (word === other ? 0 : 1),
        ),
      );
    row = next;
  }
  return row[actual.length];
}

if (process.platform !== 'darwin' || !process.env.WHISPER_MODEL)
  throw new Error(
    'Set WHISPER_MODEL to a local model and run on macOS with an installed Russian say voice.',
  );
process.env.WHISPER_MODEL = path.resolve(process.env.WHISPER_MODEL);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skoobi-local-voice-eval-'));
const initialDir = process.cwd();
try {
  process.chdir(root);
  process.env.CLAUDECLAW_ENV_FILE = path.join(root, '.env');
  fs.writeFileSync(process.env.CLAUDECLAW_ENV_FILE, '', { mode: 0o600 });
  const { transcribeAudioFileDetailed } =
    await import('../../packages/voice-stt/dist/index.js');
  const results = [];
  const requested = process.argv.slice(2);
  for (const tag of requested)
    assert.ok(
      cases.some((c) => c.tag === tag),
      'Unknown synthetic case',
    );
  for (const { tag, text, slots, call } of cases.filter(
    (c) => !requested.length || requested.includes(c.tag),
  )) {
    const file = path.join(root, tag + '.aiff');
    execFileSync(
      '/usr/bin/say',
      ['-v', 'Milena', '-r', call ? '220' : '175', '-o', file, text],
      { timeout: 30_000 },
    );
    const audio = call ? path.join(root, tag + '.ogg') : file;
    if (call) {
      // Repeatable phone-band, low-bitrate input with pink room noise.
      execFileSync(
        process.env.FFMPEG_BIN || 'ffmpeg',
        [
          '-nostdin',
          '-v',
          'error',
          '-y',
          '-i',
          file,
          '-f',
          'lavfi',
          '-i',
          'anoisesrc=color=pink:amplitude=0.13:seed=31:r=16000',
          '-filter_complex',
          '[0:a]aresample=16000,highpass=f=300,lowpass=f=3100[s];[s][1:a]amix=inputs=2:duration=first:normalize=0[out]',
          '-map',
          '[out]',
          '-ac',
          '1',
          '-c:a',
          'libopus',
          '-b:a',
          '16k',
          audio,
        ],
        { timeout: 30_000 },
      );
    }
    const recognition = await transcribeAudioFileDetailed(audio);
    const reference = words(text),
      observed = words(recognition.text || '');
    const missed = slots.flatMap((slot, i) =>
      slot.test(observed.join(' ')) ? [] : [i + 1],
    );
    results.push({
      tag,
      profile: call ? 'phone' : 'clean',
      expectedWords: reference.length,
      wordEdits: wordEdits(reference, observed),
      missedSlots: missed,
      observed: recognition.text,
      status: recognition.status,
      passes: recognition.passes.length,
      recheck: recognition.recheck,
      uncertainty: recognition.uncertainty,
      ambiguities: recognition.ambiguities,
      processingMs: recognition.metrics.processingMs,
    });
  }

  const sum = (key) => results.reduce((n, r) => n + r[key], 0);
  console.log(
    JSON.stringify(
      {
        synthetic: true,
        cases: results,
        wordErrorRate: sum('wordEdits') / sum('expectedWords'),
        semanticallyMatched: results.filter((r) => !r.missedSlots.length)
          .length,
        flaggedSemanticMisses: results
          .filter((r) => r.missedSlots.length && r.status === 'doubtful')
          .map((r) => r.tag),
        scope: 'local_asr',
      },
      null,
      2,
    ),
  );
  if (
    results.some(
      (r) =>
        !['success', 'doubtful'].includes(r.status) ||
        (r.missedSlots.length && r.status !== 'doubtful'),
    )
  )
    process.exitCode = 1;
} catch (error) {
  // The service logger has a keep-alive uncaught-exception handler. An eval
  // setup/verification error must still fail the invoking command explicitly.
  console.error(error);
  process.exitCode = 1;
} finally {
  process.chdir(initialDir);
  fs.rmSync(root, { recursive: true, force: true });
}
