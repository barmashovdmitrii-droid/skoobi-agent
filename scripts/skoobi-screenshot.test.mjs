import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  deriveScreenshot,
  displayMatchesCapture,
  fullScreenshotResult,
  parseDisplayGeometryOutput,
  parseScreenshotRequest,
  planScreenshotDerivation,
  readImageFileSize,
  readImageSize,
  resolveScreenshotDisplay,
  secureScreenshotDirectory,
} from '../helper/skoobi-helper-policy.js';

const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempRoots.push(root);
  return root;
}

function pngHeader(width, height) {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8; // bit depth
  buffer[25] = 6; // RGBA
  return buffer;
}

function jpegSegment(marker, payload) {
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = marker;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

function jpegHeader(width, height, sofMarker = 0xc0) {
  const sof = Buffer.alloc(15);
  sof[0] = 8; // precision
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 3; // components
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(
      0xe0,
      Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'),
    ),
    jpegSegment(0xe1, Buffer.alloc(300, 0x41)), // EXIF-like filler
    jpegSegment(0xdb, Buffer.alloc(65, 0)), // DQT
    jpegSegment(0xc4, Buffer.alloc(30, 0)), // DHT must not be read as SOF
    Buffer.from([0xff, 0xff]), // fill bytes before the next marker
    jpegSegment(sofMarker, sof),
    jpegSegment(0xda, Buffer.alloc(10, 0)),
  ]);
}

const RETINA = { width: 1512, height: 949, scale: 2 };
const PATHS = {
  srcPath: '/shots/1-src.png',
  regionPath: '/shots/1-region.png',
  dstPath: '/shots/1-dst.jpg',
};

function plan(request, overrides = {}) {
  return planScreenshotDerivation({
    ...PATHS,
    srcWidth: 3024,
    srcHeight: 1898,
    display: RETINA,
    request: {
      format: 'jpeg',
      maxSide: 1280,
      quality: 70,
      region: null,
      ...request,
    },
    ...overrides,
  });
}

// Every sips crop flag (-c is --cropToHeightWidth).
function stepHasCrop(step) {
  return ['-c', '--cropToHeightWidth', '--cropOffset'].some((flag) =>
    step.includes(flag),
  );
}

describe('parseScreenshotRequest', () => {
  it('keeps the legacy contract for an empty body', () => {
    expect(parseScreenshotRequest(undefined)).toBeNull();
    expect(parseScreenshotRequest(null)).toBeNull();
    expect(parseScreenshotRequest({})).toBeNull();
  });

  it('fills defaults: JPEG, longest side 1280, quality 70, whole screen', () => {
    expect(parseScreenshotRequest({ format: 'jpeg' })).toEqual({
      format: 'jpeg',
      maxSide: 1280,
      quality: 70,
      region: null,
    });
    expect(parseScreenshotRequest({ something_new: true })).toEqual({
      format: 'jpeg',
      maxSide: 1280,
      quality: 70,
      region: null,
    });
    expect(parseScreenshotRequest({ format: 'JPG' }).format).toBe('jpeg');
    expect(parseScreenshotRequest({ format: 'png' }).format).toBe('png');
  });

  it('clamps max_side and quality into their ranges', () => {
    expect(parseScreenshotRequest({ max_side: 100 }).maxSide).toBe(320);
    expect(parseScreenshotRequest({ max_side: 5000 }).maxSide).toBe(2048);
    expect(parseScreenshotRequest({ max_side: 1599.6 }).maxSide).toBe(1600);
    expect(parseScreenshotRequest({ max_side: null }).maxSide).toBeNull();
    expect(parseScreenshotRequest({ quality: 5 }).quality).toBe(30);
    expect(parseScreenshotRequest({ quality: 100 }).quality).toBe(95);
    expect(parseScreenshotRequest({ quality: 81 }).quality).toBe(81);
  });

  it('accepts a region in points', () => {
    expect(
      parseScreenshotRequest({
        region: { x: -10, y: 5.5, width: 300, height: 200 },
      }).region,
    ).toEqual({ x: -10, y: 5.5, width: 300, height: 200 });
  });

  it.each([
    ['an array body', []],
    ['a string body', 'shoot'],
    ['an unknown format', { format: 'gif' }],
    ['a string max_side', { max_side: '1280' }],
    ['a NaN max_side', { max_side: Number.NaN }],
    ['an infinite quality', { quality: Number.POSITIVE_INFINITY }],
    ['a region that is not an object', { region: [0, 0, 10, 10] }],
    [
      'a NaN region coordinate',
      { region: { x: Number.NaN, y: 0, width: 10, height: 10 } },
    ],
    [
      'a string region coordinate',
      { region: { x: '0', y: 0, width: 10, height: 10 } },
    ],
    ['a missing region field', { region: { x: 0, y: 0, width: 10 } }],
    ['a zero-width region', { region: { x: 0, y: 0, width: 0, height: 10 } }],
    [
      'a region below 4 points',
      { region: { x: 0, y: 0, width: 3, height: 10 } },
    ],
    [
      'a negative region height',
      { region: { x: 0, y: 0, width: 10, height: -10 } },
    ],
  ])('rejects %s', (_label, body) => {
    expect(() => parseScreenshotRequest(body)).toThrow(
      /invalid screenshot options/,
    );
  });
});

describe('readImageSize', () => {
  it('reads PNG IHDR dimensions', () => {
    expect(readImageSize(pngHeader(3024, 1898))).toEqual({
      format: 'png',
      width: 3024,
      height: 1898,
    });
  });

  it('reads JPEG SOF dimensions past APP/DQT/DHT segments and fill bytes', () => {
    expect(readImageSize(jpegHeader(1280, 803))).toEqual({
      format: 'jpeg',
      width: 1280,
      height: 803,
    });
    expect(readImageSize(jpegHeader(600, 400, 0xc2))).toEqual({
      format: 'jpeg',
      width: 600,
      height: 400,
    });
  });

  it('returns null for data it cannot trust', () => {
    expect(readImageSize(Buffer.from('not an image at all'))).toBeNull();
    expect(readImageSize(pngHeader(3024, 1898).subarray(0, 20))).toBeNull();
    expect(readImageSize(jpegHeader(1280, 803).subarray(0, 60))).toBeNull();
    expect(readImageSize(pngHeader(0, 10))).toBeNull();
    expect(readImageSize('string')).toBeNull();
    // Start of scan before any frame header.
    expect(
      readImageSize(
        Buffer.concat([
          Buffer.from([0xff, 0xd8]),
          jpegSegment(0xda, Buffer.alloc(4)),
        ]),
      ),
    ).toBeNull();
  });

  it('reads the size from a file head and returns null for a missing file', () => {
    const dir = tempDir('skoobi-image-size-');
    const file = path.join(dir, 'shot.jpg');
    fs.writeFileSync(file, jpegHeader(1280, 803));
    expect(readImageFileSize(file)).toEqual({
      format: 'jpeg',
      width: 1280,
      height: 803,
    });
    expect(readImageFileSize(path.join(dir, 'missing.png'))).toBeNull();
    const link = path.join(dir, 'link.jpg');
    fs.symlinkSync(file, link);
    expect(readImageFileSize(link)).toBeNull();
  });
});

describe('display geometry', () => {
  it('parses the NSScreen probe output', () => {
    expect(
      parseDisplayGeometryOutput('{"w":1512,"h":949,"scale":2,"n":1}\n'),
    ).toEqual({ width: 1512, height: 949, scale: 2, screens: 1 });
    expect(
      parseDisplayGeometryOutput('{"w":1512,"h":949,"scale":null,"n":"2"}'),
    ).toEqual({ width: 1512, height: 949, scale: null, screens: 2 });
    expect(parseDisplayGeometryOutput('')).toBeNull();
    expect(parseDisplayGeometryOutput('error: no screens')).toBeNull();
    expect(parseDisplayGeometryOutput('{"w":0,"h":949,"scale":2}')).toBeNull();
    expect(parseDisplayGeometryOutput('{"h":949,"scale":2}')).toBeNull();
  });

  it('matches a capture only when both axes agree with the display scale', () => {
    expect(displayMatchesCapture(RETINA, 3024, 1898)).toBe(true);
    // Display mode changed since the geometry was cached.
    expect(
      displayMatchesCapture(
        { width: 1728, height: 1117, scale: 2 },
        3024,
        1898,
      ),
    ).toBe(false);
    // Finder fallback (no scale): only the aspect check applies.
    expect(
      displayMatchesCapture(
        { width: 1512, height: 949, scale: null },
        3024,
        1898,
      ),
    ).toBe(true);
    // Finder union of two displays side by side: axes disagree.
    expect(
      displayMatchesCapture(
        { width: 3432, height: 1080, scale: null },
        3024,
        1898,
      ),
    ).toBe(false);
    expect(displayMatchesCapture({ width: 0, height: 949 }, 3024, 1898)).toBe(
      false,
    );
  });
});

describe('planScreenshotDerivation', () => {
  it('downscales the whole Retina screen in one sips call without a region capture', () => {
    const result = plan({});
    expect(result.capture).toBeNull();
    expect(result.steps).toEqual([
      [
        '-Z',
        '1280',
        '-s',
        'format',
        'jpeg',
        '-s',
        'formatOptions',
        '70',
        PATHS.srcPath,
        '--out',
        PATHS.dstPath,
      ],
    ]);
    expect(result.outputPath).toBe(PATHS.dstPath);
    expect(result.output).toEqual({ width: 1280, height: 803, format: 'jpeg' });
    expect(result.region).toEqual({ x: 0, y: 0, width: 1512, height: 949 });
    expect(result.resized).toBe(true);
    expect(result.scale).toEqual({ x: 2, y: 2 });
  });

  it('captures a region on its own at native Retina pixels without upscaling it', () => {
    const result = plan({ region: { x: 100, y: 50, width: 300, height: 200 } });
    expect(result.capture).toEqual({
      args: ['-x', '-R', '100,50,300,200', PATHS.regionPath],
      path: PATHS.regionPath,
      rect: { x: 100, y: 50, width: 300, height: 200 },
      expected: { width: 600, height: 400 },
    });
    expect(result.steps).toEqual([
      [
        '-s',
        'format',
        'jpeg',
        '-s',
        'formatOptions',
        '70',
        PATHS.regionPath,
        '--out',
        PATHS.dstPath,
      ],
    ]);
    expect(result.output).toEqual({ width: 600, height: 400, format: 'jpeg' });
    expect(result.resized).toBe(false);
    // 300 points over 600 pixels: 0.5 point per image pixel.
    expect(result.region).toEqual({ x: 100, y: 50, width: 300, height: 200 });
    expect(result.region.width / result.output.width).toBe(0.5);
  });

  it('never asks sips to crop: it ignores --cropOffset when x is 0', () => {
    // Menu-bar strip: sips cropped the middle of the screen for this one.
    const menuBar = plan({ region: { x: 0, y: 0, width: 1512, height: 24 } });
    expect(menuBar.capture?.args).toEqual([
      '-x',
      '-R',
      '0,0,1512,24',
      PATHS.regionPath,
    ]);
    expect(menuBar.capture?.expected).toEqual({ width: 3024, height: 48 });
    expect(menuBar.output).toEqual({ width: 1280, height: 20, format: 'jpeg' });
    expect(menuBar.region).toEqual({ x: 0, y: 0, width: 1512, height: 24 });

    // Bottom-left corner (Dock): sips handed back the whole screen for it.
    const dock = plan({ region: { x: 0, y: 750, width: 500, height: 199 } });
    expect(dock.capture?.args).toEqual([
      '-x',
      '-R',
      '0,750,500,199',
      PATHS.regionPath,
    ]);
    expect(dock.capture?.expected).toEqual({ width: 1000, height: 398 });
    expect(dock.region).toEqual({ x: 0, y: 750, width: 500, height: 199 });

    const regions = [
      null,
      { x: 0, y: 0, width: 1512, height: 949 },
      { x: 0, y: 0, width: 100, height: 15 },
      { x: 0, y: 900, width: 60, height: 49 },
      { x: 3, y: 7, width: 1500, height: 20 },
      { x: 700, y: 0, width: 40, height: 949 },
      { x: 1000, y: 600, width: 900, height: 900 },
    ];
    for (const region of regions) {
      for (const maxSide of [null, 320, 1280, 2048]) {
        for (const format of ['jpeg', 'png']) {
          const result = plan({ region, maxSide, format });
          expect(result.steps.length).toBeLessThanOrEqual(1);
          for (const step of result.steps) {
            expect(stepHasCrop(step)).toBe(false);
            // A region is read from its own capture, never from the full one.
            if (result.capture) expect(step).not.toContain(PATHS.srcPath);
          }
        }
      }
    }
  });

  it('clamps a region that is partly off the screen and rounds it outward to whole points', () => {
    const result = plan({
      region: { x: 1400, y: 900, width: 300, height: 200 },
    });
    expect(result.capture?.rect).toEqual({
      x: 1400,
      y: 900,
      width: 112,
      height: 49,
    });
    expect(result.capture?.expected).toEqual({ width: 224, height: 98 });
    expect(result.region).toEqual({ x: 1400, y: 900, width: 112, height: 49 });

    const negative = plan({
      region: { x: -50, y: -20, width: 100, height: 60 },
    });
    expect(negative.capture?.args[2]).toBe('0,0,50,40');
    expect(negative.capture?.expected).toEqual({ width: 100, height: 80 });
    expect(negative.region).toEqual({ x: 0, y: 0, width: 50, height: 40 });

    // A region converted from image pixels has fractional points.
    const fractional = plan({
      region: { x: 10.4, y: 20.6, width: 5.2, height: 5.2 },
    });
    expect(fractional.capture?.args[2]).toBe('10,20,6,6');
    expect(fractional.capture?.expected).toEqual({ width: 12, height: 12 });
    expect(fractional.region).toEqual({ x: 10, y: 20, width: 6, height: 6 });
  });

  it('uses the full capture for a region that covers the whole display', () => {
    for (const region of [
      { x: 0, y: 0, width: 1512, height: 949 },
      { x: -10, y: -10, width: 2000, height: 2000 },
    ]) {
      const result = plan({ region });
      expect(result.capture).toBeNull();
      expect(result.steps[0]).toContain(PATHS.srcPath);
      expect(result.region).toEqual({ x: 0, y: 0, width: 1512, height: 949 });
    }
  });

  it('refuses a region that misses the screen', () => {
    let error;
    try {
      plan({ region: { x: 2000, y: 10, width: 100, height: 100 } });
    } catch (caught) {
      error = caught;
    }
    expect(error?.message).toMatch(/outside the screen/);
    expect(error?.code).toBe('SCREENSHOT_REGION_OUTSIDE');
  });

  it('downscales a region capture in one sips call', () => {
    const result = plan({
      maxSide: 800,
      region: { x: 10, y: 10, width: 1400, height: 900 },
    });
    expect(result.capture?.expected).toEqual({ width: 2800, height: 1800 });
    expect(result.steps).toEqual([
      [
        '-Z',
        '800',
        '-s',
        'format',
        'jpeg',
        '-s',
        'formatOptions',
        '70',
        PATHS.regionPath,
        '--out',
        PATHS.dstPath,
      ],
    ]);
    expect(result.output).toEqual({ width: 800, height: 514, format: 'jpeg' });
    expect(result.resized).toBe(true);
  });

  it('fits a tall region by its height', () => {
    const result = plan({
      maxSide: 320,
      region: { x: 0, y: 0, width: 100, height: 900 },
    });
    expect(result.output).toEqual({ width: 36, height: 320, format: 'jpeg' });
  });

  it('keeps full resolution when max_side is null', () => {
    const result = plan({ maxSide: null });
    expect(result.steps).toEqual([
      [
        '-s',
        'format',
        'jpeg',
        '-s',
        'formatOptions',
        '70',
        PATHS.srcPath,
        '--out',
        PATHS.dstPath,
      ],
    ]);
    expect(result.output).toEqual({
      width: 3024,
      height: 1898,
      format: 'jpeg',
    });
  });

  it('hands back the capture itself for an unchanged PNG, region or not', () => {
    const same = plan({ format: 'png', maxSide: null });
    expect(same.steps).toEqual([]);
    expect(same.outputPath).toBe(PATHS.srcPath);

    const region = plan({
      format: 'png',
      region: { x: 100, y: 50, width: 300, height: 200 },
    });
    expect(region.steps).toEqual([]);
    expect(region.outputPath).toBe(PATHS.regionPath);
    expect(region.output).toEqual({ width: 600, height: 400, format: 'png' });

    const resized = plan({ format: 'png' });
    expect(resized.steps).toEqual([
      [
        '-Z',
        '1280',
        '-s',
        'format',
        'png',
        PATHS.srcPath,
        '--out',
        PATHS.dstPath,
      ],
    ]);
  });

  it('uses the per-axis pixel ratio of a non-Retina capture', () => {
    const result = plan(
      { region: { x: 10, y: 10, width: 100, height: 50 } },
      { srcWidth: 1512, srcHeight: 949, display: { ...RETINA, scale: 1 } },
    );
    expect(result.capture?.rect).toEqual({
      x: 10,
      y: 10,
      width: 100,
      height: 50,
    });
    expect(result.capture?.expected).toEqual({ width: 100, height: 50 });
    expect(result.region).toEqual({ x: 10, y: 10, width: 100, height: 50 });
  });

  it('rejects impossible inputs', () => {
    expect(() => plan({}, { srcWidth: 0 })).toThrow(/source size/);
    expect(() => plan({}, { srcHeight: 1.5 })).toThrow(/source size/);
    expect(() => plan({}, { display: { width: 0, height: 949 } })).toThrow(
      /display geometry/,
    );
    expect(() => plan({ format: 'gif' })).toThrow(/request/);
    expect(() =>
      plan(
        { region: { x: 1, y: 1, width: 10, height: 10 } },
        { regionPath: '' },
      ),
    ).toThrow(/regionPath/);
  });
});

describe('screenshot cleanup covers derived files', () => {
  it('removes old JPEG and PNG screenshots and leaves unmanaged names alone', () => {
    const directory = path.join(tempDir('skoobi-screenshots-'), 'shots');
    fs.mkdirSync(directory, { mode: 0o755 });
    const nowMs = Date.now();
    const uuid = '00000000-0000-4000-8000-000000000000';
    const oldJpeg = path.join(directory, `${nowMs - 60_000}-${uuid}.jpg`);
    const oldIntermediate = path.join(directory, `${nowMs - 60_000}.png`);
    const recentJpeg = path.join(directory, `${nowMs}-${uuid}.jpg`);
    const recentJpegLong = path.join(directory, `${nowMs + 1}.JPEG`);
    const unmanaged = path.join(directory, 'kie-x.png');
    for (const file of [
      oldJpeg,
      oldIntermediate,
      recentJpeg,
      recentJpegLong,
      unmanaged,
    ]) {
      fs.writeFileSync(file, 'image', { mode: 0o644 });
    }
    // Establish the permissions under test independently of the runner's umask.
    fs.chmodSync(unmanaged, 0o644);
    for (const file of [oldJpeg, oldIntermediate, unmanaged]) {
      fs.utimesSync(file, new Date(nowMs - 60_000), new Date(nowMs - 60_000));
    }

    const result = secureScreenshotDirectory(directory, {
      nowMs,
      retentionMs: 30_000,
      maxFiles: 20,
    });

    expect(result).toEqual({ deleted: 2, retained: 2 });
    expect(fs.existsSync(oldJpeg)).toBe(false);
    expect(fs.existsSync(oldIntermediate)).toBe(false);
    expect(fs.statSync(recentJpeg).mode & 0o777).toBe(0o600);
    expect(fs.statSync(recentJpegLong).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(unmanaged)).toBe(true);
    expect(fs.statSync(unmanaged).mode & 0o777).toBe(0o644);
  });
});

describe('resolveScreenshotDisplay', () => {
  function geometrySource(...answers) {
    const calls = [];
    return {
      calls,
      getGeometry: async (options) => {
        calls.push(options);
        return answers[Math.min(calls.length - 1, answers.length - 1)];
      },
    };
  }
  const capture = { width: 3024, height: 1898 };

  it('uses the cached geometry when it matches the capture', async () => {
    const source = geometrySource(RETINA);
    await expect(
      resolveScreenshotDisplay(capture, source.getGeometry),
    ).resolves.toBe(RETINA);
    expect(source.calls).toEqual([{ refresh: false }]);
  });

  it('refreshes once when the cached geometry is stale', async () => {
    const stale = { width: 1728, height: 1117, scale: 2 };
    const source = geometrySource(stale, RETINA);
    await expect(
      resolveScreenshotDisplay(capture, source.getGeometry),
    ).resolves.toBe(RETINA);
    expect(source.calls).toEqual([{ refresh: false }, { refresh: true }]);
  });

  it('trusts the capture for the scale when both axes agree', async () => {
    const wrongScale = { width: 1512, height: 949, scale: 1 };
    const source = geometrySource(wrongScale);
    await expect(
      resolveScreenshotDisplay(capture, source.getGeometry),
    ).resolves.toEqual({ width: 1512, height: 949, scale: 2 });
  });

  it('gives no geometry when the axes disagree', async () => {
    const union = { width: 3432, height: 1080, scale: null };
    await expect(
      resolveScreenshotDisplay(capture, geometrySource(union).getGeometry),
    ).resolves.toBeNull();
    await expect(
      resolveScreenshotDisplay(
        capture,
        geometrySource({ width: 0, height: 949 }).getGeometry,
      ),
    ).resolves.toBeNull();
  });
});

describe('deriveScreenshot', () => {
  const UUID_RE =
    '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

  function makeCapture(width = 3024, height = 1898) {
    const directory = path.join(tempDir('skoobi-derive-'), 'shots');
    fs.mkdirSync(directory, { mode: 0o700 });
    const stamp = 1_700_000_000_000;
    const file = path.join(
      directory,
      `${stamp}-00000000-0000-4000-8000-000000000000.png`,
    );
    fs.writeFileSync(file, pngHeader(width, height), { mode: 0o600 });
    return {
      directory,
      src: {
        path: file,
        bytes: fs.statSync(file).size,
        stamp,
        size: readImageFileSize(file),
      },
    };
  }

  // Stand-in for `screencapture -x -R x,y,w,h <file>`: writes a PNG header of
  // the rect at `scale` pixels per point, like the real tool on Retina.
  function fakeCapture(calls = [], scale = 2) {
    return async (args, options) => {
      calls.push({ args, options });
      const [, , width, height] = args[args.indexOf('-R') + 1]
        .split(',')
        .map(Number);
      fs.writeFileSync(
        args[args.length - 1],
        pngHeader(Math.round(width * scale), Math.round(height * scale)),
      );
    };
  }

  // Stand-in for /usr/bin/sips: writes an image header of the size the real
  // tool would produce, so the orchestration can be tested anywhere.
  function fakeSips(calls = []) {
    return async (args, options) => {
      calls.push({ args, options });
      if (stepHasCrop(args)) throw new Error('sips must never crop');
      const output = args[args.indexOf('--out') + 1];
      const input = args[args.indexOf('--out') - 1];
      let { width, height } = readImageFileSize(input);
      const zoom = args.indexOf('-Z');
      if (zoom !== -1) {
        const maxSide = Number(args[zoom + 1]);
        const factor = maxSide / Math.max(width, height);
        [width, height] = [
          Math.round(width * factor),
          Math.round(height * factor),
        ];
      }
      const format = args[args.indexOf('format') + 1];
      fs.writeFileSync(
        output,
        format === 'jpeg'
          ? jpegHeader(width, height)
          : pngHeader(width, height),
      );
    };
  }

  function recorder() {
    const entries = [];
    return {
      entries,
      log: (level, msg, extra) => entries.push({ level, msg, ...extra }),
    };
  }

  const JPEG_REQUEST = {
    format: 'jpeg',
    maxSide: 1280,
    quality: 70,
    region: null,
  };

  it('writes a private managed JPEG and removes the capture and region capture', async () => {
    const { directory, src } = makeCapture();
    const captureCalls = [];
    const sipsCalls = [];
    const { entries, log } = recorder();
    const result = await deriveScreenshot({
      src,
      request: {
        ...JPEG_REQUEST,
        region: { x: 100, y: 50, width: 1000, height: 800 },
      },
      directory,
      resolveDisplay: async () => ({ ...RETINA, screens: 1 }),
      captureRegion: fakeCapture(captureCalls),
      runSips: fakeSips(sipsCalls),
      log,
    });

    expect(result.path).toMatch(new RegExp(`/${src.stamp}-${UUID_RE}\\.jpg$`));
    expect(path.dirname(result.path)).toBe(directory);
    expect(fs.statSync(result.path).mode & 0o777).toBe(0o600);
    expect(result).toMatchObject({
      bytes: fs.statSync(result.path).size,
      format: 'jpeg',
      width: 1280,
      height: 1024,
      region: { x: 100, y: 50, width: 1000, height: 800 },
      display: { width: 1512, height: 949, scale: 2, screens: 1 },
      source_width: 3024,
      source_height: 1898,
      downscaled: true,
    });
    expect(result.fallback).toBeUndefined();
    expect(fs.readdirSync(directory)).toEqual([path.basename(result.path)]);

    expect(captureCalls).toHaveLength(1);
    const regionFile = captureCalls[0].args[3];
    expect(captureCalls[0].args.slice(0, 3)).toEqual([
      '-x',
      '-R',
      '100,50,1000,800',
    ]);
    expect(path.dirname(regionFile)).toBe(directory);
    expect(regionFile).toMatch(new RegExp(`/${src.stamp}-${UUID_RE}\\.png$`));
    expect(sipsCalls).toHaveLength(1);
    expect(sipsCalls[0].args).toContain(regionFile);
    expect(sipsCalls[0].args).not.toContain(src.path);
    for (const { options } of [...captureCalls, ...sipsCalls]) {
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(10_000);
    }
    expect(entries).toEqual([]);
  });

  it('maps with the size actually written, not the planned one', async () => {
    const { directory, src } = makeCapture();
    const result = await deriveScreenshot({
      src,
      request: JPEG_REQUEST,
      directory,
      resolveDisplay: async () => RETINA,
      captureRegion: fakeCapture(),
      runSips: async (args) => {
        fs.writeFileSync(
          args[args.indexOf('--out') + 1],
          jpegHeader(1280, 804),
        );
      },
    });
    expect(result).toMatchObject({ width: 1280, height: 804 });
  });

  it('hands back the region capture itself for a full-resolution PNG region', async () => {
    const { directory, src } = makeCapture();
    const sipsCalls = [];
    const result = await deriveScreenshot({
      src,
      request: {
        format: 'png',
        maxSide: null,
        quality: 70,
        region: { x: 0, y: 900, width: 60, height: 49 },
      },
      directory,
      resolveDisplay: async () => RETINA,
      captureRegion: fakeCapture(),
      runSips: fakeSips(sipsCalls),
    });
    expect(result).toMatchObject({
      format: 'png',
      width: 120,
      height: 98,
      region: { x: 0, y: 900, width: 60, height: 49 },
      downscaled: false,
    });
    expect(sipsCalls).toHaveLength(0);
    expect(fs.readdirSync(directory)).toEqual([path.basename(result.path)]);
    expect(result.path).not.toBe(src.path);
  });

  const writeOut = (writer) => async (args) => {
    fs.writeFileSync(args[args.indexOf('--out') + 1], writer());
  };

  it.each([
    [
      'screencapture fails',
      async () => {
        throw new Error('screencapture: cannot capture');
      },
      fakeSips(),
      'region_capture',
    ],
    [
      'screencapture writes nothing',
      async () => {},
      fakeSips(),
      'region_capture',
    ],
    [
      'the region capture is not at native pixels',
      fakeCapture([], 1),
      fakeSips(),
      'region_capture',
    ],
    [
      'the region capture is the whole screen',
      async (args) => {
        fs.writeFileSync(args[args.length - 1], pngHeader(3024, 1898));
      },
      fakeSips(),
      'region_capture',
    ],
    [
      'sips fails',
      fakeCapture(),
      async () => {
        throw new Error('sips: Error 13');
      },
      'sips',
    ],
    ['sips writes nothing', fakeCapture(), async () => {}, 'verify'],
    [
      'sips writes the wrong format',
      fakeCapture(),
      writeOut(() => pngHeader(200, 200)),
      'verify',
    ],
    [
      // What sips did with `--cropOffset <y> 0` reaching the bottom edge.
      'sips hands back the whole screen instead of the planned size',
      fakeCapture(),
      writeOut(() => jpegHeader(3024, 1898)),
      'verify',
    ],
    [
      'sips writes a size off by more than a pixel',
      fakeCapture(),
      writeOut(() => jpegHeader(200, 202)),
      'verify',
    ],
  ])(
    'falls back to the full-size capture when %s',
    async (_label, captureRegion, runSips, stage) => {
      const { directory, src } = makeCapture();
      const { entries, log } = recorder();
      const result = await deriveScreenshot({
        src,
        request: {
          ...JPEG_REQUEST,
          region: { x: 10, y: 10, width: 100, height: 100 },
        },
        directory,
        resolveDisplay: async () => RETINA,
        captureRegion,
        runSips,
        log,
      });
      expect(result).toEqual({
        path: src.path,
        bytes: src.bytes,
        format: 'png',
        width: 3024,
        height: 1898,
        region: { x: 0, y: 0, width: 1512, height: 949 },
        display: { width: 1512, height: 949, scale: 2 },
        source_width: 3024,
        source_height: 1898,
        downscaled: false,
        fallback: true,
      });
      // Only the capture itself is left behind.
      expect(fs.readdirSync(directory)).toEqual([path.basename(src.path)]);
      expect(entries).toEqual([
        {
          level: 'warn',
          msg: 'screenshot_downscale_failed',
          stage,
          error_type: 'Error',
        },
      ]);
    },
  );

  it('falls back when a full-screen downscale has another size', async () => {
    const { directory, src } = makeCapture();
    const result = await deriveScreenshot({
      src,
      request: JPEG_REQUEST,
      directory,
      resolveDisplay: async () => RETINA,
      captureRegion: fakeCapture(),
      // -Z ignored: the full-size image instead of 1280x803.
      runSips: writeOut(() => jpegHeader(3024, 1898)),
    });
    expect(result).toMatchObject({ path: src.path, fallback: true });
    expect(fs.readdirSync(directory)).toEqual([path.basename(src.path)]);
  });

  it('falls back when the time budget is used up', async () => {
    for (const region of [null, { x: 10, y: 10, width: 100, height: 100 }]) {
      const { directory, src } = makeCapture();
      const captureCalls = [];
      const sipsCalls = [];
      const result = await deriveScreenshot({
        src,
        request: { ...JPEG_REQUEST, region },
        directory,
        resolveDisplay: async () => RETINA,
        captureRegion: fakeCapture(captureCalls),
        runSips: fakeSips(sipsCalls),
        budgetMs: 0,
      });
      expect(result.fallback).toBe(true);
      expect(captureCalls).toHaveLength(0);
      expect(sipsCalls).toHaveLength(0);
    }
  });

  it('returns the legacy answer without geometry when the display is unknown', async () => {
    for (const resolveDisplay of [
      async () => null,
      async () => {
        throw new Error('osascript failed');
      },
    ]) {
      const { directory, src } = makeCapture();
      const { entries, log } = recorder();
      const result = await deriveScreenshot({
        src,
        request: JPEG_REQUEST,
        directory,
        resolveDisplay,
        captureRegion: fakeCapture(),
        runSips: fakeSips(),
        log,
      });
      expect(result).toEqual({
        path: src.path,
        bytes: src.bytes,
        format: 'png',
        width: 3024,
        height: 1898,
      });
      expect(entries[0]).toMatchObject({ msg: 'screenshot_downscale_failed' });
    }
  });

  it('returns the legacy answer when the capture size is unreadable', async () => {
    const { directory, src } = makeCapture();
    const result = await deriveScreenshot({
      src: { ...src, size: null },
      request: JPEG_REQUEST,
      directory,
      resolveDisplay: async () => RETINA,
      captureRegion: fakeCapture(),
      runSips: fakeSips(),
    });
    expect(result).toEqual({ path: src.path, bytes: src.bytes, format: 'png' });
  });

  it('reports a region off the screen instead of returning another area', async () => {
    const { directory, src } = makeCapture();
    const captureCalls = [];
    await expect(
      deriveScreenshot({
        src,
        request: {
          ...JPEG_REQUEST,
          region: { x: 5000, y: 0, width: 50, height: 50 },
        },
        directory,
        resolveDisplay: async () => RETINA,
        captureRegion: fakeCapture(captureCalls),
        runSips: fakeSips(),
      }),
    ).rejects.toMatchObject({ code: 'SCREENSHOT_REGION_OUTSIDE' });
    expect(captureCalls).toHaveLength(0);
    expect(fs.readdirSync(directory)).toEqual([path.basename(src.path)]);
  });

  it('hands back the capture for an unchanged full-resolution PNG', async () => {
    const { directory, src } = makeCapture();
    const result = await deriveScreenshot({
      src,
      request: { format: 'png', maxSide: null, quality: 70, region: null },
      directory,
      resolveDisplay: async () => RETINA,
      captureRegion: fakeCapture(),
      runSips: fakeSips(),
    });
    expect(result).toMatchObject({
      path: src.path,
      format: 'png',
      width: 3024,
      height: 1898,
      region: { x: 0, y: 0, width: 1512, height: 949 },
      downscaled: false,
    });
    expect(fs.existsSync(src.path)).toBe(true);
  });

  it('builds the legacy answer for an empty request', () => {
    expect(
      fullScreenshotResult(
        {
          path: '/shots/1.png',
          bytes: 10,
          size: { width: 3024, height: 1898 },
        },
        null,
      ),
    ).toEqual({
      path: '/shots/1.png',
      bytes: 10,
      format: 'png',
      width: 3024,
      height: 1898,
    });
  });
});

// ---------------------------------------------------------------------------
// Real /usr/bin/sips on synthetic images (no screen capture involved).
// ---------------------------------------------------------------------------

const SIPS = '/usr/bin/sips';
const hasSips = process.platform === 'darwin' && fs.existsSync(SIPS);

// A synthetic 200x150 point "display" at Retina scale 2 (400x300 px). Its
// pixel (x, y) is R = point x, G = point y, B = 0: every pixel of a derived
// image names the screen point it shows.
const SYNTHETIC_DISPLAY = { width: 200, height: 150, scale: 2 };

// 24-bit BMP of the synthetic display's pixels inside `rect` (pixels).
function writeScreenBmp(file, rect) {
  const { width, height } = rect;
  const { scale } = SYNTHETIC_DISPLAY;
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const data = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y += 1) {
    const row = height - 1 - y; // BMP rows are stored bottom-up
    for (let x = 0; x < width; x += 1) {
      const offset = row * rowSize + x * 3;
      data[offset] = 0;
      data[offset + 1] = Math.floor((rect.y + y) / scale);
      data[offset + 2] = Math.floor((rect.x + x) / scale);
    }
  }
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'latin1');
  header.writeUInt32LE(54 + data.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(data.length, 34);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

// Pixel {r, g} at (x, y) of an uncompressed 24/32-bit BMP.
function bmpPixel(bmp, x, y) {
  const dataOffset = bmp.readUInt32LE(10);
  const width = bmp.readInt32LE(18);
  const height = bmp.readInt32LE(22);
  const bytesPerPixel = bmp.readUInt16LE(28) / 8;
  const rowSize = Math.ceil((width * bytesPerPixel) / 4) * 4;
  const row = height < 0 ? y : height - 1 - y;
  const offset = dataOffset + row * rowSize + x * bytesPerPixel;
  return { r: bmp[offset + 2], g: bmp[offset + 1] };
}

function sips(args) {
  execFileSync(SIPS, args, { stdio: 'ignore', timeout: 15_000 });
}

// Checks that the image's corners and centre show the screen points the
// region/size mapping (the runner's pixel -> point formula) says they show.
// JPEG and downscaling blur a few levels; a wrong crop origin is off by tens.
function expectImageShows(file, region) {
  const size = readImageFileSize(file);
  const probe = `${file}.probe.bmp`;
  sips(['-s', 'format', 'bmp', file, '--out', probe]);
  const bmp = fs.readFileSync(probe);
  fs.rmSync(probe);
  for (const [fx, fy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
    [0.5, 0.5],
  ]) {
    const px = Math.min(size.width - 1, Math.floor(fx * size.width));
    const py = Math.min(size.height - 1, Math.floor(fy * size.height));
    // Colour = whole point, so a pixel averages to about point - 0.5.
    const pointX = region.x + ((px + 0.5) * region.width) / size.width - 0.5;
    const pointY = region.y + ((py + 0.5) * region.height) / size.height - 0.5;
    const { r, g } = bmpPixel(bmp, px, py);
    const where = `pixel (${px}, ${py}) shows point (${r}, ${g}), mapped to (${pointX.toFixed(1)}, ${pointY.toFixed(1)})`;
    expect(Math.abs(r - pointX), where).toBeLessThanOrEqual(5);
    expect(Math.abs(g - pointY), where).toBeLessThanOrEqual(5);
  }
}

describe.skipIf(!hasSips)('real sips on a synthetic display', () => {
  // The full capture of the synthetic display, as a PNG like screencapture's.
  function syntheticCapture(directory, name) {
    const bmp = path.join(directory, 'screen.bmp');
    writeScreenBmp(bmp, { x: 0, y: 0, width: 400, height: 300 });
    const src = path.join(directory, name);
    sips(['-s', 'format', 'png', bmp, '--out', src]);
    fs.rmSync(bmp);
    return src;
  }

  // Stand-in for `screencapture -x -R x,y,w,h <file>`: renders those points
  // of the synthetic display at native pixels (sips only converts BMP to PNG
  // here, nothing is cropped).
  function syntheticScreencapture(scratch) {
    const { scale } = SYNTHETIC_DISPLAY;
    return async (args) => {
      const [x, y, width, height] = args[args.indexOf('-R') + 1]
        .split(',')
        .map(Number);
      const bmp = path.join(scratch, 'region.bmp');
      writeScreenBmp(bmp, {
        x: x * scale,
        y: y * scale,
        width: width * scale,
        height: height * scale,
      });
      sips(['-s', 'format', 'png', bmp, '--out', args[args.length - 1]]);
      fs.rmSync(bmp);
    };
  }

  it('downscales the whole capture and keeps every pixel in place', () => {
    const dir = tempDir('skoobi-sips-');
    const src = syntheticCapture(dir, '1-src.png');
    expect(readImageFileSize(src)).toEqual({
      format: 'png',
      width: 400,
      height: 300,
    });
    const dst = path.join(dir, '1-dst.jpg');
    const result = planScreenshotDerivation({
      srcPath: src,
      regionPath: path.join(dir, '1-region.png'),
      dstPath: dst,
      srcWidth: 400,
      srcHeight: 300,
      display: SYNTHETIC_DISPLAY,
      request: { format: 'jpeg', maxSide: 320, quality: 70, region: null },
    });
    expect(result.capture).toBeNull();
    for (const step of result.steps) sips(step);
    expect(readImageFileSize(dst)).toEqual({
      format: 'jpeg',
      width: 320,
      height: 240,
    });
    expectImageShows(dst, result.region);
  });

  // x = 0 is where `sips --cropOffset` broke: the top-left zoom came back as
  // the centre of the screen, the bottom-left one as the whole screen.
  it.each([
    ['menu-bar strip', { x: 0, y: 0, width: 200, height: 12 }, 320],
    ['bottom-left corner', { x: 0, y: 100, width: 60, height: 50 }, 64],
    ['top-left block', { x: 0, y: 0, width: 180, height: 100 }, 320],
    ['inner detail', { x: 50, y: 25, width: 40, height: 30 }, 1280],
  ])(
    'zooms into the %s and maps its pixels to the right points',
    async (_label, region, maxSide) => {
      const dir = tempDir('skoobi-sips-');
      const directory = path.join(dir, 'shots');
      fs.mkdirSync(directory, { mode: 0o700 });
      const stamp = 1_700_000_000_000;
      const capture = syntheticCapture(
        directory,
        `${stamp}-00000000-0000-4000-8000-000000000000.png`,
      );
      const result = await deriveScreenshot({
        src: {
          path: capture,
          bytes: fs.statSync(capture).size,
          stamp,
          size: readImageFileSize(capture),
        },
        request: { format: 'jpeg', maxSide, quality: 70, region },
        directory,
        resolveDisplay: async () => SYNTHETIC_DISPLAY,
        captureRegion: syntheticScreencapture(dir),
        runSips: async (args, options) => {
          execFileSync(SIPS, args, {
            stdio: 'ignore',
            timeout: options.timeout,
          });
        },
      });
      expect(result.fallback).toBeUndefined();
      expect(result).toMatchObject({ format: 'jpeg', region });
      const native = Math.max(region.width, region.height) * 2;
      expect(result.downscaled).toBe(native > maxSide);
      expect(readImageFileSize(result.path)).toEqual({
        format: 'jpeg',
        width: result.width,
        height: result.height,
      });
      expectImageShows(result.path, result.region);
      expect(fs.statSync(result.path).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(directory)).toEqual([path.basename(result.path)]);
      expect(secureScreenshotDirectory(directory).retained).toBe(1);
    },
  );
});
