import type { FactoryPlatform } from './game-factory-contracts.js';
import type { FactoryManifest } from './game-factory-artifacts.js';

export interface FactoryPlatformProfile {
  id: string;
  platform: FactoryPlatform;
  enginePath: 'html5' | 'roblox_studio';
  sdk: 'not_required' | 'optional' | 'required' | 'not_applicable';
  documentationCheckedOn: string;
  documentation: string[];
  maxTotalBytes?: number;
  maxFiles?: number;
  manualRequirements: string[];
}

export interface FactoryPlatformPreflight {
  profile: FactoryPlatformProfile;
  manifestSha256: string;
  status: 'pass' | 'fail' | 'not_applicable';
  checks: Array<{
    id: string;
    result: 'pass' | 'fail' | 'unknown';
    detail: string;
  }>;
  /** Local checks cannot authorize publishing or certify portal compliance. */
  releaseReady: false;
}

const CHECKED_ON = '2026-11-04';

/** Small, dated rule profiles; live portal/device/human review remains explicit. */
export function getFactoryPlatformProfile(
  platform: FactoryPlatform,
  mode: 'preview' | 'basic' | 'full' = 'preview',
): FactoryPlatformProfile {
  const common = { platform, documentationCheckedOn: CHECKED_ON };
  switch (platform) {
    case 'yandex':
      return {
        ...common,
        id: 'yandex-html5',
        enginePath: 'html5',
        sdk: 'required',
        documentation: [
          'https://yandex.com/dev/games/doc/en/concepts/requirements',
        ],
        maxTotalBytes: 100_000_000,
        manualRequirements: [
          'Verify SDK initialization, loading/gameplay lifecycle, pause and audio on focus/ad changes in the portal.',
          'Verify immediate progress saving, SDK language selection and all declared devices.',
          'Interactive AI is prohibited; pre-generated AI assets may be used subject to rights and content rules.',
          'Confirm current account eligibility, monetization, promotional materials and human quality review before submission.',
        ],
      };
    case 'crazygames':
      return {
        ...common,
        id: mode === 'full' ? 'crazygames-full' : 'crazygames-basic',
        enginePath: 'html5',
        sdk: mode === 'full' ? 'required' : 'optional',
        documentation: [
          'https://docs.crazygames.com/',
          'https://docs.crazygames.com/requirements/technical/',
        ],
        maxTotalBytes: 250_000_000,
        maxFiles: 1500,
        manualRequirements: [
          mode === 'full'
            ? 'Full Launch requires platform selection and full SDK integration; verify gameplay start/stop and applicable save/account modules.'
            : 'Basic Launch has monetization disabled. Optional SDK integration still requires accurate gameplay-start events.',
          'Initial download must be at most 50 MB, or 20 MB for mobile-homepage eligibility. Without SDK, total bundle size is used.',
          'Verify relative bundle URLs, declared browser/device support and portal preview; mobile emulation does not verify physical devices.',
          'Human quality review and real audience feedback determine launch readiness; a local pass does not imply acceptance.',
        ],
      };
    case 'roblox':
      return {
        ...common,
        id: 'roblox-studio',
        enginePath: 'roblox_studio',
        sdk: 'not_applicable',
        documentation: [
          'https://create.roblox.com/docs/cloud/guides/usage-place-publishing',
        ],
        manualRequirements: [
          'Use the separate Luau/Rojo/Studio workflow; an HTML5 ZIP is not a Roblox place.',
          'Verify server/client behavior, two-client play, saves, migrations and purchase idempotency in an isolated test place.',
          'Open Cloud updates existing places with scoped permissions; some instance changes require Studio publishing.',
          'Publishing or modifying an existing live world requires explicit project authorization and version readback.',
        ],
      };
    case 'local':
      return {
        ...common,
        id: 'local-html5',
        enginePath: 'html5',
        sdk: 'not_required',
        documentation: [],
        manualRequirements: [
          'This profile is a local prototype check, not platform approval, a complete playthrough or human fun acceptance.',
        ],
      };
    default:
      throw new Error('Unknown factory platform');
  }
}

export function checkFactoryPlatformManifest(input: {
  manifest: FactoryManifest;
  platform: FactoryPlatform;
  mode?: 'preview' | 'basic' | 'full';
}): FactoryPlatformPreflight {
  const { manifest, platform, mode } = input;
  const profile = getFactoryPlatformProfile(platform, mode);
  const checks: FactoryPlatformPreflight['checks'] = [];
  const add = (id: string, passed: boolean, detail: string) =>
    checks.push({ id, result: passed ? 'pass' : 'fail', detail });
  if (profile.enginePath === 'roblox_studio') {
    return {
      profile,
      manifestSha256: manifest.manifestSha256,
      status: 'not_applicable',
      checks: [
        {
          id: 'separate_engine',
          result: 'unknown',
          detail: 'HTML5 preflight does not verify a Roblox Studio build.',
        },
      ],
      releaseReady: false,
    };
  }
  add(
    'html_entrypoint',
    /\.html?$/i.test(manifest.entrypoint) &&
      manifest.files.some((file) => file.path === manifest.entrypoint),
    'The captured manifest contains the selected HTML entrypoint.',
  );
  if (profile.maxTotalBytes !== undefined)
    add(
      'total_bytes',
      manifest.totalBytes <= profile.maxTotalBytes,
      `${manifest.totalBytes} bytes; profile cap ${profile.maxTotalBytes} bytes (decimal MB).`,
    );
  if (profile.maxFiles !== undefined)
    add(
      'file_count',
      manifest.files.length <= profile.maxFiles,
      `${manifest.files.length} files; profile cap ${profile.maxFiles}.`,
    );
  if (platform === 'yandex') {
    add(
      'root_index',
      manifest.entrypoint === 'index.html',
      'Yandex requires index.html at the bundle root.',
    );
    add(
      'portable_names',
      manifest.files.every(
        (file) => !/[\s\p{Script=Cyrillic}]/u.test(file.path),
      ),
      'Yandex filenames and folders must contain neither whitespace nor Cyrillic characters.',
    );
  }
  checks.push({
    id: 'portal_device_human_review',
    result: 'unknown',
    detail:
      'SDK behavior, live ads, saves, actual devices, content rights and human quality are not proved by a manifest.',
  });
  return {
    profile,
    manifestSha256: manifest.manifestSha256,
    status: checks.some((check) => check.result === 'fail') ? 'fail' : 'pass',
    checks,
    releaseReady: false,
  };
}
