import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  acceptCorrection,
  addPromptLinks,
  applyLinkCheck,
  buildLinkFixPrompt,
  checkLinks,
  clearForeignContentReads,
  createLinkCheckRun,
  DEAD_MARK,
  defaultProbeDeps,
  extractForeignUrls,
  extractLinks,
  FIX_TURN_MAX_MS,
  FOREIGN_READ_MARKER_ENV,
  foreignContentReads,
  foreignReadMarkerPath,
  FOREIGN_URLS_MAX_AGE_MS,
  FOREIGN_URLS_MAX_ENTRIES,
  foreignUrlsFilePath,
  indexPromptLinks,
  isPrivateAddress,
  LINK_FIX_DISCARDED_NOTE,
  linkFixDiscarded,
  linkSkipReason,
  markDeadLinks,
  MAX_LINKS,
  prepareForeignReadMarker,
  probeUrl,
  proxyConfiguredInEnv,
  readForeignUrls,
  recordForeignContentRead,
  recordForeignUrls,
  saveLinkFixNote,
  STALE_FOREIGN_READ_MARKER_MS,
  takeLinkFixNote,
  type LinkCorrectionResult,
  type ProbeDeps,
} from './link-check.js';

type Route = (
  url: string,
  method: string,
) => Response | Promise<Response> | Error;

function resp(
  status: number,
  headers: Record<string, string> = {},
  cancel = vi.fn(async () => {}),
): Response {
  return {
    status,
    headers: new Headers(headers),
    body: { cancel },
  } as unknown as Response;
}

function fetchError(code: string): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(code), { code }),
  });
}

function dnsError(code: string): Error {
  return Object.assign(new Error(`getaddrinfo ${code}`), { code });
}

function fakeFetch(route: Route) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const out = await route(String(input), init?.method ?? 'GET');
    if (out instanceof Error) throw out;
    return out;
  });
}

function deps(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    fetchImpl: fakeFetch(() => resp(200)) as unknown as typeof fetch,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    resolve: async () => ['93.184.216.34'],
    canary: async () => true,
    isBlockedAddress: isPrivateAddress,
    proxyConfigured: false,
    ...overrides,
  };
}

describe('extractLinks', () => {
  it('finds a markdown link and marks after its closing parenthesis', () => {
    const text = 'см. [текст](https://a.kz/x) дальше';
    const links = extractLinks(text);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      url: 'https://a.kz/x',
      kind: 'markdown',
      normalized: 'https://a.kz/x',
    });
    expect(text.slice(0, links[0].markAt)).toBe('см. [текст](https://a.kz/x)');
  });

  it('trims punctuation around bare URLs but keeps balanced parentheses', () => {
    const urls = (text: string) => extractLinks(text).map((link) => link.url);
    expect(urls('см. https://a.kz/x.')).toEqual(['https://a.kz/x']);
    expect(urls('(https://a.kz/x)')).toEqual(['https://a.kz/x']);
    expect(urls('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ]);
    expect(urls('**https://a.kz/y**')).toEqual(['https://a.kz/y']);
    expect(urls('«https://a.kz/z», и всё')).toEqual(['https://a.kz/z']);
    expect(urls('см. https://a.kz/w…')).toEqual(['https://a.kz/w']);
  });

  it('reads a markdown link with parentheses in its URL whole — the URL Telegram now gets', () => {
    // telegram.ts sends the parentheses as %28/%29, so the whole address
    // arrives; the check must probe that address and mark after the link.
    const text =
      'см. [Меркурий](https://ru.wikipedia.org/wiki/Меркурий_(планета)).';
    const links = extractLinks(text);
    expect(links.map((link) => [link.kind, link.url])).toEqual([
      ['markdown', 'https://ru.wikipedia.org/wiki/Меркурий_(планета)'],
    ]);
    expect(markDeadLinks(text, new Set([links[0].normalized]))).toBe(
      `см. [Меркурий](https://ru.wikipedia.org/wiki/Меркурий_(планета))${DEAD_MARK}.`,
    );
  });

  it('keeps a trailing underscore that belongs to the address (adilet)', () => {
    expect(
      extractLinks('Закон: https://adilet.zan.kz/rus/docs/Z980000220_ ').map(
        (link) => link.url,
      ),
    ).toEqual(['https://adilet.zan.kz/rus/docs/Z980000220_']);
  });

  it('ignores inline code, fences and <internal> blocks', () => {
    const text = [
      'Запрос: `POST https://api.apiframe.ai/v2/music/generate`',
      '```\ncurl https://b.kz/api\n```',
      '<internal>черновик https://c.kz/d</internal>',
      'и живая https://e.kz/f',
    ].join('\n');
    expect(extractLinks(text).map((link) => link.url)).toEqual([
      'https://e.kz/f',
    ]);
  });

  it('ignores other schemes and schemeless addresses', () => {
    const text =
      'mailto:fixture@example.test tel:+100 tg://resolve?domain=x file:///etc/hosts t.me/x www.x.kz';
    expect(extractLinks(text)).toEqual([]);
  });

  it('dedupes by URL without #fragment but keeps every occurrence', () => {
    const text = 'https://a.kz/x и снова [тут](https://a.kz/x#part)';
    const links = extractLinks(text);
    expect(links).toHaveLength(2);
    expect(new Set(links.map((link) => link.normalized)).size).toBe(1);
  });
});

describe('linkSkipReason', () => {
  it('skips private and local hosts', () => {
    for (const url of [
      'http://localhost:3000/x',
      'http://127.0.0.1/x',
      'http://10.1.2.3/',
      'http://172.20.0.1/',
      'http://192.168.1.1/',
      'http://169.254.1.1/',
      'http://100.100.1.1/',
      'http://[::1]/x',
      'http://[fd00::1]/x',
      'https://x.local/',
      'https://x.internal/',
      'https://box.tail1234.ts.net/',
      'http://intranet/',
    ]) {
      expect(linkSkipReason(url, ''), url).toBe('private-host');
    }
    expect(linkSkipReason('https://8.8.8.8/', '')).toBeNull();
  });

  it('skips Telegram links: they answer 200 for any name', () => {
    expect(linkSkipReason('https://t.me/example_bot', '')).toBe('unverifiable');
    expect(linkSkipReason('https://telegram.me/x', '')).toBe('unverifiable');
  });

  it('skips links a GET could use up', () => {
    const credentialedUrl = new URL('https://example.test/path');
    credentialedUrl.username = 'fixture-user';
    credentialedUrl.password = 'fixture-password';
    for (const url of [
      'https://a.kz/x?token=abc',
      'https://a.kz/x?access_token=abc',
      'https://s3.amazonaws.com/b/k?X-Amz-Signature=abc',
      'https://a.kz/auth?code=123',
      'https://a.kz/mail/unsubscribe/42',
      'https://a.kz/oauth/callback',
      credentialedUrl.toString(),
    ]) {
      expect(linkSkipReason(url, ''), url).toBe('sensitive');
    }
  });

  it('skips one-time confirmation, login and invite links in their common forms', () => {
    for (const url of [
      // Devise: a GET (and on Rails a HEAD) confirms / unlocks / resets.
      'https://x.com/users/confirmation?confirmation_token=AbC123',
      'https://x.com/users/unlock?unlock_token=abc',
      'https://x.com/users/password/edit?reset_password_token=abc',
      'https://x.com/confirm-email/tok123',
      'https://x.com/verify-email?t=abc',
      'https://app.y.com/auth/magic-link/tok',
      'https://slack.example.com/magic-login/tok',
      'https://x.com/login?login_token=abc',
      'https://x.com/invite/tok',
      'https://x.com/api/emailConfirm/abc',
      'https://x.com/a?accessToken=abc',
      'https://x.com/a?session_id=1',
      'https://x.com/a.php?PHPSESSID=abc',
      'https://x.com/a?user[confirmation_token]=1',
      'https://zoom.example.com/j/123?pwd=abc',
      'https://x.com/signin?next=/',
      'https://x.com/oauth2/authorize?client_id=1',
      'https://x.com/s/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2ln',
      'https://x.com/u?e=abc',
      'https://shop.kz/checkout/step-1',
      'https://kaspi.kz/pay/123',
      'https://example.com/track/click?id=1',
    ]) {
      expect(linkSkipReason(url, ''), url).toBe('sensitive');
    }
  });

  it('skips one-time links written together or behind short token paths', () => {
    for (const url of [
      'https://app.x.io/emailverification/Q2x9abcDEF',
      'https://app.x.io/v/Q2x9abcDEF',
      'https://go.x.io/r/7Hk2mP9qLx',
      'https://x.io/l/aB3dE9fGhJ',
      'https://x.io/join/Zx81kQpL0mN2vB7tR4sY',
      'https://www.notion.so/loginwithemail?x=1',
      'https://www.docusign.net/Member/EmailStart.aspx?a=4f8e2b1c-3d5a-4e6f-8a9b-0c1d2e3f4a5b&er=9c7d5e3f-1a2b-4c6d-8e0f-a1b2c3d4e5f6',
      'https://x.io/account/resetpassword',
      'https://x.io/users/sign_in',
      'https://x.io/AccountActivation?id=1',
      'https://x.io/s/aB3dE9fGhJ2kL4mN7pQ',
      'https://x.io/files/3f2b9c1e-7a4d-4e2b-9f1a-2b3c4d5e6f70',
      'https://x.io/%76erify/abc',
    ]) {
      expect(linkSkipReason(url, ''), url).toBe('sensitive');
    }
  });

  it('still probes ordinary article and shop pages next to those rules', () => {
    for (const url of [
      'https://kaspi.kz/shop/p/iphone-15-128gb-chernyi-113137790/',
      'https://www.tutu.ru/poezda/Mineralnye_Vody/',
      'https://en.wikipedia.org/wiki/Foo_(bar)',
      'https://www.ozon.ru/product/smartfon-apple-iphone-15-128gb-1234567890/',
      'https://medium.com/@anna/some-title-3f2b9c1e7a4d',
      'https://habr.com/ru/articles/845123/',
      'https://example.com/blog/designing-data-intensive-applications',
      'https://www.amazon.com/dp/B08N5WRWNW',
      'https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG',
      'https://open.spotify.com/album/1ATL5GLyefJaxhQzSPVrLX',
      'https://www.reddit.com/r/programming/',
      'https://2gis.kz/almaty/firm/70005550000006890',
    ]) {
      expect(linkSkipReason(url, ''), url).toBeNull();
    }
  });

  it('skips mail click trackers: a probe would be a click for the owner', () => {
    for (const url of [
      'https://us1.list-manage.com/track/click?u=1&id=2&e=3',
      'https://u123.ct.sendgrid.net/ls/click?upn=abc',
      'https://mailchi.mp/abc/def',
      'https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fa.kz',
      'https://track.example-realty.kz/r/9f3c2a7b?utm=wa',
      'https://click.mail.example.com/x/y',
    ]) {
      expect(linkSkipReason(url, ''), url).toBe('tracker');
    }
  });

  it('still checks ordinary pages', () => {
    for (const url of [
      'https://www.tutu.ru/poezda/Mineralnye_Vody/',
      'https://en.wikipedia.org/wiki/Foo_(bar)',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.google.com/search?q=token',
      'https://kolesa.kz/cars/?page=2&sort=price',
      'https://example.com/blog/payload-design',
      'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
      'https://example.com/search?keyword=велосипед',
      'https://docs.python.org/3/library/hashlib.html',
      'https://example.com/posts?author=Ivan',
      'https://link.springer.com/article/10.1007/abc',
    ]) {
      expect(linkSkipReason(url, ''), url).toBeNull();
    }
  });

  it('skips templates', () => {
    expect(linkSkipReason('https://api.a.kz/jobs/{jobId}', '')).toBe(
      'template',
    );
    expect(linkSkipReason('https://api.a.kz/jobs/%7BjobId%7D', '')).toBe(
      'template',
    );
    expect(linkSkipReason('https://api.a.kz/users/:id', '')).toBe('template');
  });

  it('never touches a URL that came with the prompt', () => {
    const prompt = 'Иван: вот ссылка https://a.kz/page/ посмотри';
    expect(linkSkipReason('https://a.kz/page/', prompt)).toBe('in-prompt');
    expect(linkSkipReason('https://a.kz/page', prompt)).toBe('in-prompt');
    expect(linkSkipReason('https://a.kz/other', prompt)).toBeNull();
  });

  it('remembers links from every prompt of the run, not only the last one', () => {
    const repo = 'https://git.example.test/member/demo';
    const run = addPromptLinks(
      indexPromptLinks(`Иван: вот мой репозиторий ${repo}, глянь README`),
      'Иван: сделай план',
    );
    expect(linkSkipReason(repo, run)).toBe('in-prompt');
    expect(linkSkipReason(repo, 'Иван: сделай план')).toBeNull();
  });
});

describe('probeUrl', () => {
  it('HEAD 200 is ok; a relative redirect is followed', async () => {
    expect((await probeUrl('https://a.kz/x', deps())).verdict).toBe('ok');
    const fetchImpl = fakeFetch((url) =>
      url === 'https://a.kz/old' ? resp(301, { location: '/new' }) : resp(200),
    );
    const result = await probeUrl(
      'https://a.kz/old',
      deps({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    expect(result.verdict).toBe('ok');
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://a.kz/old',
      'https://a.kz/new',
    ]);
  });

  it('404 is dead only when GET confirms it', async () => {
    const dead = await probeUrl(
      'https://a.kz/gone',
      deps({
        fetchImpl: fakeFetch(() => resp(404)) as unknown as typeof fetch,
      }),
    );
    expect(dead).toMatchObject({
      verdict: 'dead',
      reason: 'http-404',
      label: 'HTTP 404',
    });
    const headOnly = await probeUrl(
      'https://a.kz/x',
      deps({
        fetchImpl: fakeFetch((_url, method) =>
          method === 'HEAD' ? resp(404) : resp(200),
        ) as unknown as typeof fetch,
      }),
    );
    expect(headOnly.verdict).toBe('ok');
  });

  it('HEAD 405 / 403 fall back to GET', async () => {
    for (const headStatus of [405, 403]) {
      const result = await probeUrl(
        'https://a.kz/x',
        deps({
          fetchImpl: fakeFetch((_url, method) =>
            method === 'HEAD' ? resp(headStatus) : resp(200),
          ) as unknown as typeof fetch,
        }),
      );
      expect(result.verdict, String(headStatus)).toBe('ok');
    }
  });

  it('410 is dead (removed listing)', async () => {
    const result = await probeUrl(
      'https://www.olx.kz/d/obyavlenie/x.html',
      deps({
        fetchImpl: fakeFetch(() => resp(410)) as unknown as typeof fetch,
      }),
    );
    expect(result).toMatchObject({ verdict: 'dead', reason: 'http-410' });
  });

  it('auth, anti-bot, rate limits and server errors are unknown', async () => {
    for (const status of [400, 401, 403, 407, 429, 451, 500, 503]) {
      const result = await probeUrl(
        'https://a.kz/x',
        deps({
          fetchImpl: fakeFetch(() => resp(status)) as unknown as typeof fetch,
        }),
      );
      expect(result, String(status)).toMatchObject({
        verdict: 'unknown',
        reason: `http-${status}`,
      });
    }
  });

  it('a 404 on code hosting may be a private repository', async () => {
    for (const url of [
      'https://github.com/owner/private-repo/blob/main/x.ts',
      'https://gitlab.com/a/b',
      'https://bitbucket.org/a/b',
    ]) {
      const result = await probeUrl(
        url,
        deps({
          fetchImpl: fakeFetch(() => resp(404)) as unknown as typeof fetch,
        }),
      );
      expect(result, url).toMatchObject({
        verdict: 'unknown',
        reason: 'private-or-missing',
      });
    }
  });

  it('NXDOMAIN is dead only when the second resolver agrees and the net is up', async () => {
    const fetchImpl = fakeFetch(() => resp(200));
    const nx = {
      lookup: async () => {
        throw dnsError('ENOTFOUND');
      },
      resolve: async () => {
        throw dnsError('ENOTFOUND');
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };
    expect(
      await probeUrl('https://no-such-domain-xyz.kz/', deps(nx)),
    ).toMatchObject({ verdict: 'dead', reason: 'nxdomain' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      await probeUrl(
        'https://no-such-domain-xyz.kz/',
        deps({ ...nx, canary: async () => false }),
      ),
    ).toMatchObject({ verdict: 'unknown', reason: 'offline' });
    expect(
      await probeUrl(
        'https://a.kz/',
        deps({
          lookup: async () => {
            throw dnsError('EAI_AGAIN');
          },
        }),
      ),
    ).toMatchObject({ verdict: 'unknown', reason: 'dns' });
    expect(
      await probeUrl(
        'https://a.kz/',
        deps({
          ...nx,
          resolve: async () => ['1.2.3.4'],
        }),
      ),
    ).toMatchObject({ verdict: 'unknown', reason: 'dns' });
  });

  it('a refused connection is dead only with a live net and no proxy', async () => {
    const refusing = {
      fetchImpl: fakeFetch(() =>
        fetchError('ECONNREFUSED'),
      ) as unknown as typeof fetch,
    };
    expect(await probeUrl('https://a.kz/', deps(refusing))).toMatchObject({
      verdict: 'dead',
      reason: 'refused',
      label: 'сервер не отвечает',
    });
    expect(
      await probeUrl(
        'https://a.kz/',
        deps({ ...refusing, proxyConfigured: true }),
      ),
    ).toMatchObject({ verdict: 'unknown', reason: 'refused' });
    expect(
      await probeUrl(
        'https://a.kz/',
        deps({ ...refusing, canary: async () => false }),
      ),
    ).toMatchObject({ verdict: 'unknown', reason: 'offline' });
  });

  it('TLS trouble, resets and timeouts are unknown (edu.gov.ru, rzd.ru)', async () => {
    for (const code of [
      'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'CERT_HAS_EXPIRED',
    ]) {
      const result = await probeUrl(
        'https://edu.gov.ru/',
        deps({
          fetchImpl: fakeFetch(() =>
            fetchError(code),
          ) as unknown as typeof fetch,
        }),
      );
      expect(result, code).toMatchObject({ verdict: 'unknown', reason: 'tls' });
    }
    expect(
      await probeUrl(
        'https://a.kz/',
        deps({
          fetchImpl: fakeFetch(() =>
            fetchError('ECONNRESET'),
          ) as unknown as typeof fetch,
        }),
      ),
    ).toMatchObject({ verdict: 'unknown', reason: 'network' });
    const hanging = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const slow = await probeUrl(
      'https://a.kz/',
      deps({
        fetchImpl: hanging as unknown as typeof fetch,
        timeouts: { headMs: 20, getMs: 20, perLinkMs: 1000 },
      }),
    );
    expect(slow).toMatchObject({ verdict: 'unknown', reason: 'timeout' });
  });

  it('never follows a redirect into the private network, nor forever', async () => {
    const toLocal = fakeFetch((url) =>
      url.startsWith('https://a.kz')
        ? resp(302, { location: 'http://127.0.0.1/admin' })
        : resp(200),
    );
    expect(
      await probeUrl(
        'https://a.kz/x',
        deps({ fetchImpl: toLocal as unknown as typeof fetch }),
      ),
    ).toMatchObject({ verdict: 'unknown', reason: 'private-redirect' });
    expect(toLocal).toHaveBeenCalledTimes(1);

    const toPrivateDns = fakeFetch((url) =>
      url.startsWith('https://a.kz')
        ? resp(302, { location: 'https://files.corp-example.kz/x' })
        : resp(200),
    );
    expect(
      await probeUrl(
        'https://a.kz/x',
        deps({
          fetchImpl: toPrivateDns as unknown as typeof fetch,
          lookup: async (host: string) => [
            {
              address:
                host === 'files.corp-example.kz' ? '10.0.0.5' : '1.2.3.4',
              family: 4,
            },
          ],
        }),
      ),
    ).toMatchObject({ verdict: 'unknown', reason: 'private-address' });

    // 09.10: an endless chain is still capped at MAX_REDIRECTS + 1 requests,
    // but one that stays on its domain now reads «alive» (ok) instead of
    // unknown — only a chain that leaves the domain keeps the old verdict.
    let hop = 0;
    const loop = fakeFetch(() => resp(302, { location: `/r${++hop}` }));
    expect(
      await probeUrl(
        'https://a.kz/r0',
        deps({ fetchImpl: loop as unknown as typeof fetch }),
      ),
    ).toMatchObject({ verdict: 'ok', reason: 'redirect-exhausted' });
    expect(loop).toHaveBeenCalledTimes(6);
  });

  it('stops an Ozon-style same-address query loop after two hops as alive', async () => {
    // Живая проверка 09.10: ozon.kz/product/… → 307 ?__rr=1 → 307 ?__rr=2 …
    // без конца (антибот), HEAD и GET одинаково; 26 «unknown:redirects» за
    // 11 дней — все такие, все живые. Два хопа вместо шести: −1 с на ссылку.
    let rr = 0;
    const ozon = fakeFetch(() =>
      resp(307, { location: `https://ozon.kz/product/tv-123?__rr=${++rr}` }),
    );
    expect(
      await probeUrl(
        'https://ozon.kz/product/tv-123',
        deps({ fetchImpl: ozon as unknown as typeof fetch }),
      ),
    ).toMatchObject({ verdict: 'ok', reason: 'redirect-loop-alive' });
    expect(ozon).toHaveBeenCalledTimes(2);
    // HEAD decides; no GET round after it.
    expect(
      ozon.mock.calls.map((call) => (call[1] as RequestInit).method),
    ).toEqual(['HEAD', 'HEAD']);

    // www. is the same site, and a redirect to another page is not a loop.
    const www = fakeFetch((url) =>
      url === 'https://kaspi.kz/shop/p/x'
        ? resp(301, { location: 'https://www.kaspi.kz/shop/p/x' })
        : url === 'https://www.kaspi.kz/shop/p/x'
          ? resp(302, { location: 'https://www.kaspi.kz/shop/p/x?lang=ru' })
          : resp(200),
    );
    expect(
      await probeUrl(
        'https://kaspi.kz/shop/p/x',
        deps({ fetchImpl: www as unknown as typeof fetch }),
      ),
    ).toMatchObject({ verdict: 'ok', reason: 'ok', status: 200 });
    expect(www).toHaveBeenCalledTimes(3);
  });

  it('counts only consecutive same-address query hops as a loop: http→https→?query→404 is still dead (check 09.10, SR-1)', async () => {
    // Before: the protocol hop and the query hop both matched «same
    // host+path» → two hops → ok/redirect-loop-alive, and the 404 behind
    // them was never asked for.
    const chain = fakeFetch((url) =>
      url === 'http://shop.kz/item/123'
        ? resp(301, { location: 'https://shop.kz/item/123' })
        : url === 'https://shop.kz/item/123'
          ? resp(302, { location: 'https://shop.kz/item/123?city=almaty' })
          : resp(404),
    );
    expect(
      await probeUrl(
        'http://shop.kz/item/123',
        deps({ fetchImpl: chain as unknown as typeof fetch }),
      ),
    ).toMatchObject({ verdict: 'dead', reason: 'http-404' });
    // HEAD chain (3) + GET confirmation chain (3).
    expect(chain).toHaveBeenCalledTimes(6);

    // A path hop between two query hops resets the count: no loop, the
    // final response decides.
    const broken = fakeFetch((url) =>
      url === 'https://a.kz/p'
        ? resp(302, { location: 'https://a.kz/p?r=1' })
        : url === 'https://a.kz/p?r=1'
          ? resp(302, { location: 'https://a.kz/q' })
          : url === 'https://a.kz/q'
            ? resp(302, { location: 'https://a.kz/q?r=2' })
            : resp(200),
    );
    expect(
      await probeUrl(
        'https://a.kz/p',
        deps({ fetchImpl: broken as unknown as typeof fetch }),
      ),
    ).toMatchObject({ verdict: 'ok', reason: 'ok', status: 200 });
    expect(broken).toHaveBeenCalledTimes(4);

    // The Ozon loop (same protocol+host+path, query changes every hop) is
    // still cut after REDIRECT_LOOP_HOPS consecutive hops as alive.
    let rr = 0;
    const ozon = fakeFetch(() =>
      resp(307, { location: `https://ozon.kz/product/tv-123?__rr=${++rr}` }),
    );
    expect(
      await probeUrl(
        'https://ozon.kz/product/tv-123',
        deps({ fetchImpl: ozon as unknown as typeof fetch }),
      ),
    ).toMatchObject({ verdict: 'ok', reason: 'redirect-loop-alive' });
    expect(ozon).toHaveBeenCalledTimes(2);
  });

  it('keeps a redirect chain that leaves the domain as unknown', async () => {
    let hop = 0;
    const away = fakeFetch((url) =>
      resp(302, {
        location: url.startsWith('https://a.kz')
          ? `https://b.kz/r${++hop}`
          : `https://a.kz/r${++hop}`,
      }),
    );
    expect(
      await probeUrl(
        'https://a.kz/r0',
        deps({ fetchImpl: away as unknown as typeof fetch }),
      ),
    ).toMatchObject({ verdict: 'unknown', reason: 'redirects' });
    expect(away).toHaveBeenCalledTimes(6);

    // A same-address loop reached only after leaving the domain says nothing
    // about the original link — still unknown.
    let rr = 0;
    const crossLoop = fakeFetch((url) =>
      url.startsWith('https://a.kz')
        ? resp(302, { location: 'https://b.kz/p' })
        : resp(307, { location: `https://b.kz/p?__rr=${++rr}` }),
    );
    expect(
      await probeUrl(
        'https://a.kz/x',
        deps({ fetchImpl: crossLoop as unknown as typeof fetch }),
      ),
    ).toMatchObject({ verdict: 'unknown', reason: 'redirects' });
  });

  it('asks like a browser and drops the body unread', async () => {
    const cancel = vi.fn(async () => {});
    const fetchImpl = fakeFetch((_url, method) =>
      method === 'HEAD' ? resp(405) : resp(200, {}, cancel),
    );
    await probeUrl(
      'https://a.kz/x',
      deps({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(init.redirect).toBe('manual');
    expect(headers['user-agent']).toMatch(/Chrome\/\d+/);
    expect(headers.accept).toContain('text/html');
    expect(headers['accept-language']).toBe('ru,en;q=0.8');
  });
});

describe('probeUrl over a real socket', () => {
  let server: http.Server;
  let base = '';
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/ok') res.writeHead(200);
      else if (req.url === '/moved') res.writeHead(301, { location: '/ok' });
      else if (req.url === '/head405')
        res.writeHead(req.method === 'HEAD' ? 405 : 200);
      else res.writeHead(404);
      res.end(req.method === 'HEAD' ? undefined : 'body');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const realDeps = (): ProbeDeps => ({
    ...defaultProbeDeps({}),
    isBlockedAddress: () => false,
    canary: async () => true,
  });

  it('reads real statuses, redirects and HEAD refusals', async () => {
    expect((await probeUrl(`${base}/ok`, realDeps())).verdict).toBe('ok');
    expect((await probeUrl(`${base}/moved`, realDeps())).verdict).toBe('ok');
    expect((await probeUrl(`${base}/head405`, realDeps())).verdict).toBe('ok');
    expect(await probeUrl(`${base}/gone`, realDeps())).toMatchObject({
      verdict: 'dead',
      reason: 'http-404',
    });
  });

  it('a closed port is a refused connection', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, '127.0.0.1', () => resolve()),
    );
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect(
      await probeUrl(`http://127.0.0.1:${port}/x`, realDeps()),
    ).toMatchObject({ verdict: 'dead', reason: 'refused' });
  });
});

describe('checkLinks', () => {
  it('keeps at most 6 requests in flight and 2 per host', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const perHost = new Map<string, number>();
    let maxPerHost = 0;
    const fetchImpl = fakeFetch(async (url) => {
      const host = new URL(url).hostname;
      inFlight += 1;
      perHost.set(host, (perHost.get(host) ?? 0) + 1);
      maxInFlight = Math.max(maxInFlight, inFlight);
      maxPerHost = Math.max(maxPerHost, perHost.get(host)!);
      await new Promise((resolve) => setTimeout(resolve, 5 + (url.length % 7)));
      inFlight -= 1;
      perHost.set(host, perHost.get(host)! - 1);
      return resp(200);
    });
    const urls = Array.from(
      { length: 20 },
      (_, i) => `https://h${i % 4}.kz/p${i}`,
    );
    const results = await checkLinks(urls, {
      totalMs: 5000,
      deps: deps({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    });
    expect(results.size).toBe(20);
    expect([...results.values()].every((r) => r.verdict === 'ok')).toBe(true);
    expect(maxInFlight).toBeLessThanOrEqual(6);
    expect(maxPerHost).toBeLessThanOrEqual(2);
  });

  it('returns at the deadline and marks the rest as budget', async () => {
    const signals: AbortSignal[] = [];
    const hanging = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          if (init?.signal) signals.push(init.signal);
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const started = Date.now();
    const results = await checkLinks(['https://a.kz/1', 'https://b.kz/2'], {
      totalMs: 100,
      deps: deps({ fetchImpl: hanging as unknown as typeof fetch }),
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(100 + 150);
    expect([...results.values()].map((r) => r.reason)).toEqual([
      'budget',
      'budget',
    ]);
    // The in-flight requests are cancelled, not left hanging.
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});

describe('markDeadLinks', () => {
  it('marks every occurrence, leaves code alone and is idempotent', () => {
    const dead = new Set(['https://a.kz/x']);
    const text =
      'Смотри [тут](https://a.kz/x), ещё https://a.kz/x и `https://a.kz/x`.';
    const once = markDeadLinks(text, dead);
    expect(once).toBe(
      `Смотри [тут](https://a.kz/x)${DEAD_MARK}, ещё https://a.kz/x${DEAD_MARK} и \`https://a.kz/x\`.`,
    );
    expect(markDeadLinks(once, dead)).toBe(once);
    expect(markDeadLinks(text, new Set())).toBe(text);
  });
});

describe('acceptCorrection', () => {
  const original =
    'Для примера выбрана учебная поездка: поезд №100, отправление в 12:00. ' +
    'Есть свободное купе целиком. Маршрут описан на сайте: ' +
    '[Город А → Город Б](https://travel.example.test/trains/City_A/City_B/).';

  it('takes the same answer with another link', () => {
    expect(
      acceptCorrection(
        original,
        original.replace('City_A', 'City-A'),
      ),
    ).toEqual({ ok: true });
  });

  it('rejects empty, shrunk, bloated, rewritten and meta answers', () => {
    const long = `${'Длинный подробный ответ про поезда и билеты. '.repeat(20)}[Туту](https://www.tutu.ru/x)`;
    expect(acceptCorrection(original, '')).toMatchObject({ reason: 'empty' });
    expect(acceptCorrection(long, long.slice(0, 200))).toMatchObject({
      reason: 'too-short',
    });
    expect(
      acceptCorrection(original, `${original} ${'лишнее '.repeat(300)}`),
    ).toMatchObject({ reason: 'too-long' });
    expect(
      acceptCorrection(
        original,
        'Совсем другой текст про погоду в Алматы и курс тенге на сегодня.',
      ),
    ).toMatchObject({ reason: 'changed-too-much' });
    expect(
      acceptCorrection(original, `Исправленный ответ:\n\n${original}`),
    ).toMatchObject({ reason: 'meta' });
  });
});

describe('buildLinkFixPrompt', () => {
  it('is framed as a system check and forbids sending tools', () => {
    const prompt = buildLinkFixPrompt([
      { url: 'https://a.kz/x', label: 'HTTP 404' },
    ]);
    expect(prompt).toMatch(/^<link_check source="system">/);
    expect(prompt).toContain('- https://a.kz/x — HTTP 404');
    expect(prompt).toContain('Не вызывай send_message');
    expect(prompt).toContain('ПОЛНЫЙ исправленный ответ');
  });
});

describe('applyLinkCheck', () => {
  const T = 1_000_000;
  const DEAD = 'https://www.tutu.ru/poezda/Mineralnye_Vody/';
  const GOOD = 'https://www.tutu.ru/poezda/Mineralnye-Vody/';
  const answer = `Вот ссылка на Туту: [Минеральные Воды](${DEAD}) — выбери дату и поезд.`;

  function routedDeps(deadUrls: string[]) {
    const fetchImpl = fakeFetch((url) =>
      deadUrls.some((dead) => url.startsWith(dead)) ? resp(404) : resp(200),
    );
    return {
      fetchImpl,
      deps: deps({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    };
  }

  function run(
    overrides: Partial<
      Parameters<typeof applyLinkCheck<LinkCorrectionResult>>[0]
    > = {},
  ) {
    const { deps: probeDeps } = routedDeps([DEAD]);
    const runCorrection = vi.fn(
      async (
        _prompt: string,
        _timeoutMs: number,
      ): Promise<LinkCorrectionResult> => ({
        status: 'success',
        text: answer.replace(DEAD, GOOD),
      }),
    );
    return {
      runCorrection,
      promise: applyLinkCheck<LinkCorrectionResult>({
        text: answer,
        promptText: 'Скинь ссылку на туту',
        mode: 'fix',
        turnDeadlineAt: T + 600_000,
        deps: probeDeps,
        runCorrection,
        log: () => {},
        now: () => T,
        ...overrides,
      }),
    };
  }

  it('does nothing without links', async () => {
    const { fetchImpl, deps: probeDeps } = routedDeps([]);
    const outcome = await applyLinkCheck({
      text: 'Ссылок тут нет.',
      promptText: '',
      mode: 'fix',
      turnDeadlineAt: T + 600_000,
      deps: probeDeps,
      runCorrection: vi.fn(),
      log: () => {},
      now: () => T,
    });
    expect(outcome.text).toBe('Ссылок тут нет.');
    expect(outcome.summary).toMatchObject({ found: 0, checked: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps the answer when every link opens', async () => {
    const { runCorrection, promise } = run({
      text: `Вот: [Туту](${GOOD})`,
    });
    const outcome = await promise;
    expect(outcome.text).toBe(`Вот: [Туту](${GOOD})`);
    expect(outcome.summary).toMatchObject({ checked: 1, ok: 1, dead: 0 });
    expect(runCorrection).not.toHaveBeenCalled();
  });

  it('runs exactly one correction for a dead link and takes it', async () => {
    const { runCorrection, promise } = run();
    const outcome = await promise;
    expect(runCorrection).toHaveBeenCalledTimes(1);
    const [prompt, timeoutMs] = runCorrection.mock.calls[0];
    expect(prompt).toContain(`${DEAD} — HTTP 404`);
    expect(timeoutMs).toBe(FIX_TURN_MAX_MS);
    expect(outcome.text).toBe(answer.replace(DEAD, GOOD));
    expect(outcome.summary).toMatchObject({
      dead: 1,
      correction: 'applied',
      dead_hosts: ['www.tutu.ru'],
      recheck_checked: 1,
      recheck_dead: 0,
    });
    // Hosts only: no path of the dead link anywhere in the summary.
    expect(JSON.stringify(outcome.summary)).not.toContain('Mineralnye');
  });

  it('caps the correction by what is left of the turn budget', async () => {
    const { runCorrection, promise } = run({ turnDeadlineAt: T + 200_000 });
    await promise;
    expect(runCorrection.mock.calls[0][1]).toBe(170_000);
  });

  it('marks a new dead link from the correction without a second correction', async () => {
    const NEW_DEAD = 'https://www.tutu.ru/poezda/also-broken/';
    const { deps: probeDeps } = routedDeps([DEAD, NEW_DEAD]);
    const runCorrection = vi.fn(async () => ({
      status: 'success' as const,
      text: answer.replace(DEAD, NEW_DEAD),
    }));
    const outcome = await applyLinkCheck({
      text: answer,
      promptText: '',
      mode: 'fix',
      turnDeadlineAt: T + 600_000,
      deps: probeDeps,
      runCorrection,
      log: () => {},
      now: () => T,
    });
    expect(runCorrection).toHaveBeenCalledTimes(1);
    expect(outcome.text).toBe(
      answer.replace(`(${DEAD})`, `(${NEW_DEAD})${DEAD_MARK}`),
    );
    expect(outcome.summary).toMatchObject({
      correction: 'applied',
      recheck_dead: 1,
      marked: 1,
    });
  });

  it('marks the original when the correction fails', async () => {
    for (const failure of [
      { status: 'error' as const, text: null, error: 'codex turn timed out' },
      { status: 'error' as const, text: null, error: 'interrupted' },
    ]) {
      const { promise } = run({ runCorrection: vi.fn(async () => failure) });
      const outcome = await promise;
      expect(outcome.text).toBe(
        answer.replace(`(${DEAD})`, `(${DEAD})${DEAD_MARK}`),
      );
      expect(outcome.summary.correction).toBe('failed');
    }
    const { promise } = run({
      runCorrection: vi.fn(async () => {
        throw new Error('spawn failed');
      }),
    });
    expect((await promise).summary.correction).toBe('failed');
  });

  it('marks a dead link the correction kept', async () => {
    const kept = `${answer} Проверь дату.`;
    const { promise } = run({
      runCorrection: vi.fn(async () => ({
        status: 'success' as const,
        text: kept,
      })),
    });
    const outcome = await promise;
    expect(outcome.text).toBe(
      kept.replace(`(${DEAD})`, `(${DEAD})${DEAD_MARK}`),
    );
    expect(outcome.summary.correction).toBe('applied');
  });

  it('falls back to the marked original when the correction is rejected', async () => {
    const { promise } = run({
      runCorrection: vi.fn(async () => ({
        status: 'success' as const,
        text: 'Исправленный ответ: ссылку убрал.',
      })),
    });
    const outcome = await promise;
    expect(outcome.text).toContain(`(${DEAD})${DEAD_MARK}`);
    expect(outcome.summary).toMatchObject({
      correction: 'rejected',
      fix_reject: 'meta',
    });
  });

  it('only marks when a correction is not allowed or there is no time', async () => {
    for (const reason of ['sent-mid-turn', 'thread', 'context-fill']) {
      const { runCorrection, promise } = run({ fixBlockedReason: reason });
      const outcome = await promise;
      expect(runCorrection).not.toHaveBeenCalled();
      expect(outcome.text).toContain(DEAD_MARK);
      expect(outcome.summary.correction).toBe(`skipped-${reason}`);
    }
    const { runCorrection, promise } = run({ turnDeadlineAt: T + 59_000 });
    const outcome = await promise;
    expect(runCorrection).not.toHaveBeenCalled();
    expect(outcome.summary.correction).toBe('skipped-budget');
  });

  it('shadow mode only measures', async () => {
    const { runCorrection, promise } = run({ mode: 'shadow' });
    const outcome = await promise;
    expect(outcome.text).toBe(answer);
    expect(runCorrection).not.toHaveBeenCalled();
    expect(outcome.summary).toMatchObject({
      mode: 'shadow',
      checked: 1,
      dead: 1,
      correction: 'shadow',
      reasons: { 'dead:http-404': 1 },
    });
  });

  it('mark mode marks without a correction', async () => {
    const { runCorrection, promise } = run({ mode: 'mark' });
    const outcome = await promise;
    expect(runCorrection).not.toHaveBeenCalled();
    expect(outcome.text).toBe(
      answer.replace(`(${DEAD})`, `(${DEAD})${DEAD_MARK}`),
    );
    expect(outcome.summary.correction).toBe('skipped-mark-mode');
  });

  it('never probes a URL the user sent', async () => {
    const { fetchImpl, deps: probeDeps } = routedDeps([DEAD]);
    const outcome = await applyLinkCheck({
      text: answer,
      promptText: `Иван: открой ${DEAD} пожалуйста`,
      mode: 'fix',
      turnDeadlineAt: T + 600_000,
      deps: probeDeps,
      runCorrection: vi.fn(),
      log: () => {},
      now: () => T,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome.text).toBe(answer);
    expect(outcome.summary).toMatchObject({
      skipped: 1,
      checked: 0,
      reasons: { 'skip:in-prompt': 1 },
    });
  });

  it('never probes a link after the turn read foreign content, in any mode', async () => {
    for (const mode of ['shadow', 'mark', 'fix'] as const) {
      const { fetchImpl, deps: probeDeps } = routedDeps([DEAD]);
      const runCorrection = vi.fn();
      const log = vi.fn();
      const outcome = await applyLinkCheck({
        text: answer,
        promptText: 'что нового на почте?',
        mode,
        foreignContentReads: () => ['gmail_get_thread'],
        turnDeadlineAt: T + 600_000,
        deps: probeDeps,
        runCorrection,
        log,
        now: () => T,
      });
      expect(fetchImpl, mode).not.toHaveBeenCalled();
      expect(runCorrection).not.toHaveBeenCalled();
      expect(outcome.text).toBe(answer);
      expect(outcome.summary).toMatchObject({
        mode,
        found: 1,
        checked: 0,
        skipped: 1,
        correction: 'skipped-foreign-content',
        reasons: { 'skip:foreign-content': 1 },
      });
      expect(log.mock.calls.join('\n')).toContain('gmail_get_thread');
    }
  });

  it('does not probe the new links of a correction turn that read foreign content', async () => {
    const { fetchImpl, deps: probeDeps } = routedDeps([DEAD]);
    let correctionRan = false;
    const outcome = await applyLinkCheck({
      text: answer,
      promptText: '',
      mode: 'fix',
      foreignContentReads: () => (correctionRan ? ['chat_history'] : []),
      turnDeadlineAt: T + 600_000,
      deps: probeDeps,
      runCorrection: vi.fn(async () => {
        correctionRan = true;
        return { status: 'success' as const, text: answer.replace(DEAD, GOOD) };
      }),
      log: () => {},
      now: () => T,
    });
    expect(
      fetchImpl.mock.calls.every((call) => String(call[0]).startsWith(DEAD)),
    ).toBe(true);
    expect(outcome.text).toBe(answer.replace(DEAD, GOOD));
    expect(outcome.summary).toMatchObject({
      correction: 'applied',
      reasons: { 'skip:recheck-foreign-content': 1 },
    });
    expect(outcome.summary.recheck_checked).toBeUndefined();
  });

  it('never probes a link the user sent earlier in the same run', async () => {
    const { fetchImpl, deps: probeDeps } = routedDeps([DEAD]);
    const outcome = await applyLinkCheck({
      text: answer,
      promptText: addPromptLinks(
        indexPromptLinks(`Иван: вот ${DEAD}`),
        'Иван: а на завтра?',
      ),
      mode: 'fix',
      turnDeadlineAt: T + 600_000,
      deps: probeDeps,
      runCorrection: vi.fn(),
      log: () => {},
      now: () => T,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome.summary.reasons).toEqual({ 'skip:in-prompt': 1 });
  });

  it('never probes a link from foreign text an earlier turn of the chat read, in any mode', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-check-foreign-'));
    try {
      const file = foreignUrlsFilePath(dir);
      const MAIL = 'https://app.x.io/onboarding/step-2?utm_source=mail';
      recordForeignUrls(file, `Письмо: начните тут ${MAIL}`);
      // Quoted without the query and over http: still the mail's link.
      const quoted = 'http://app.x.io/onboarding/step-2';
      const text = `Вот из письма: ${quoted}\nИ расписание: ${GOOD}`;
      for (const mode of ['shadow', 'mark', 'fix'] as const) {
        const { fetchImpl, deps: probeDeps } = routedDeps([]);
        const outcome = await applyLinkCheck({
          text,
          promptText: 'скинь ссылку из письма',
          mode,
          foreignContentReads: () => [],
          foreignUrls: () => readForeignUrls(file),
          turnDeadlineAt: T + 600_000,
          deps: probeDeps,
          runCorrection: vi.fn(),
          log: () => {},
          now: () => T,
        });
        const probed = fetchImpl.mock.calls.map((call) => String(call[0]));
        expect(
          probed.some((url) => url.includes('app.x.io')),
          mode,
        ).toBe(false);
        // Everything else is still checked.
        expect(
          probed.some((url) => url.startsWith(GOOD)),
          mode,
        ).toBe(true);
        expect(outcome.summary).toMatchObject({
          found: 2,
          checked: 1,
          skipped: 1,
          reasons: { 'skip:foreign-url': 1 },
        });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('probes nothing when the foreign-link list of the chat cannot be read', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-check-foreign-'));
    try {
      const file = foreignUrlsFilePath(dir);
      fs.writeFileSync(file, '{"at":1,"k":["not-a-hash"]}\n');
      const { fetchImpl, deps: probeDeps } = routedDeps([DEAD]);
      const runCorrection = vi.fn();
      const log = vi.fn();
      const outcome = await applyLinkCheck({
        text: answer,
        promptText: '',
        mode: 'fix',
        foreignUrls: () => readForeignUrls(file),
        turnDeadlineAt: T + 600_000,
        deps: probeDeps,
        runCorrection,
        log,
        now: () => T,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(runCorrection).not.toHaveBeenCalled();
      expect(outcome.text).toBe(answer);
      expect(outcome.summary).toMatchObject({
        checked: 0,
        skipped: 1,
        correction: 'skipped-foreign-urls-unreadable',
        reasons: { 'skip:foreign-urls-unreadable': 1 },
      });
      expect(log.mock.calls.join('\n')).toContain('cannot be read');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not recheck a foreign link the correction brought in', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-check-foreign-'));
    try {
      const file = foreignUrlsFilePath(dir);
      const MAIL = 'https://app.x.io/onboarding/step-2';
      recordForeignUrls(file, `Письмо: ${MAIL}`);
      const { fetchImpl, deps: probeDeps } = routedDeps([DEAD]);
      const outcome = await applyLinkCheck({
        text: answer,
        promptText: '',
        mode: 'fix',
        foreignUrls: () => readForeignUrls(file),
        turnDeadlineAt: T + 600_000,
        deps: probeDeps,
        runCorrection: vi.fn(async () => ({
          status: 'success' as const,
          text: answer.replace(DEAD, MAIL),
        })),
        log: () => {},
        now: () => T,
      });
      expect(
        fetchImpl.mock.calls.some((call) =>
          String(call[0]).includes('app.x.io'),
        ),
      ).toBe(false);
      expect(outcome.summary.correction).toBe('applied');
      expect(outcome.summary.recheck_checked).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it(`checks at most ${MAX_LINKS} links`, async () => {
    const text = Array.from(
      { length: 20 },
      (_, i) => `https://site${i}.kz/page`,
    ).join('\n');
    const { fetchImpl, deps: probeDeps } = routedDeps([]);
    const outcome = await applyLinkCheck({
      text,
      promptText: '',
      mode: 'shadow',
      turnDeadlineAt: T + 600_000,
      deps: probeDeps,
      runCorrection: vi.fn(),
      log: () => {},
      now: () => T,
    });
    expect(outcome.summary).toMatchObject({
      found: 20,
      checked: 12,
      truncated: 8,
    });
    expect(
      new Set(fetchImpl.mock.calls.map((call) => new URL(String(call[0])).host))
        .size,
    ).toBe(12);
  });
});

describe('foreign-read marker', () => {
  const TOKEN = '00000000-0000-4000-8000-000000000001';
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-check-marker-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lives in the IPC dir under a per-run token only', () => {
    expect(foreignReadMarkerPath(dir, TOKEN)).toBe(
      path.join(dir, `.foreign-read-${TOKEN}`),
    );
    for (const bad of [undefined, '', 'short', '../../etc/passwd-xxxxxxxx']) {
      expect(foreignReadMarkerPath(dir, bad), String(bad)).toBeNull();
    }
    expect(prepareForeignReadMarker(dir, TOKEN)).toBe(
      path.join(dir, `.foreign-read-${TOKEN}`),
    );
    // The probe write leaves nothing behind.
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(
      prepareForeignReadMarker(path.join(dir, 'missing'), TOKEN),
    ).toBeNull();
  });

  it('sweeps markers of long-dead runs, not of live ones', () => {
    const now = Date.now();
    const dead = foreignReadMarkerPath(
      dir,
      '11111111-2222-4333-8444-555555555555',
    )!;
    const live = foreignReadMarkerPath(
      dir,
      '66666666-7777-4888-8999-000000000000',
    )!;
    fs.writeFileSync(dead, 'gmail_get_thread\n');
    fs.writeFileSync(live, 'chat_history\n');
    fs.writeFileSync(path.join(dir, 'current_tasks.json'), '[]');
    const old = new Date(now - STALE_FOREIGN_READ_MARKER_MS - 60_000);
    fs.utimesSync(dead, old, old);
    fs.utimesSync(path.join(dir, 'current_tasks.json'), old, old);
    expect(prepareForeignReadMarker(dir, TOKEN, now)).not.toBeNull();
    expect(fs.readdirSync(dir).sort()).toEqual(
      [path.basename(live), 'current_tasks.json'].sort(),
    );
  });

  it('records reads, reports them once per tool and clears', () => {
    const marker = foreignReadMarkerPath(dir, TOKEN)!;
    expect(foreignContentReads(marker)).toEqual([]);
    recordForeignContentRead(marker, 'gmail_get_thread');
    recordForeignContentRead(marker, 'gmail_get_thread');
    recordForeignContentRead(marker, 'chat_history');
    expect(foreignContentReads(marker)).toEqual([
      'gmail_get_thread',
      'chat_history',
    ]);
    expect(clearForeignContentReads(marker)).toBe(true);
    expect(foreignContentReads(marker)).toEqual([]);
    expect(clearForeignContentReads(marker)).toBe(true);
    // A marker that says nothing sensible still counts as a read.
    fs.writeFileSync(marker, '');
    expect(foreignContentReads(marker)).toEqual(['unknown']);
  });
});

describe('foreign-link list of the chat', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-check-foreign-list-'));
    file = foreignUrlsFilePath(dir);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds every link of a tool result, inside JSON strings and code too', () => {
    const result = JSON.stringify(
      {
        messages: [
          {
            bodyText:
              'Подтвердите почту:\nhttps://app.x.io/emailverification/Q2x9abcDEF\nСпасибо',
          },
          {
            bodyText: 'Код: `https://x.io/a?b=1&c=2` и [тут](https://y.io/p).',
          },
        ],
      },
      null,
      2,
    );
    const urls = extractForeignUrls(result);
    expect(urls).toContain('https://app.x.io/emailverification/Q2x9abcDEF');
    expect(urls).toContain('https://x.io/a?b=1&c=2');
    expect(urls).toContain('https://y.io/p');
    expect(extractForeignUrls('нет ссылок')).toEqual([]);
  });

  it('keeps hashes only, in a private file, and matches the link as quoted', () => {
    const TOKEN_URL =
      'https://app.x.io/emailverification/Q2x9abcDEF?lang=ru#top';
    expect(readForeignUrls(file).readable).toBe(true);
    expect(readForeignUrls(file).has(TOKEN_URL)).toBe(false);
    expect(recordForeignUrls(file, 'нет ссылок')).toBe(0);
    expect(fs.existsSync(file)).toBe(false);

    expect(recordForeignUrls(file, `Письмо: ${TOKEN_URL}`)).toBe(1);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const raw = fs.readFileSync(file, 'utf-8');
    expect(raw).not.toContain('Q2x9abcDEF');
    expect(raw).not.toContain('app.x.io');
    const list = readForeignUrls(file);
    for (const quoted of [
      TOKEN_URL,
      'https://app.x.io/emailverification/Q2x9abcDEF?lang=ru',
      'https://app.x.io/emailverification/Q2x9abcDEF',
      'http://www.app.x.io/emailverification/Q2x9abcDEF/',
    ]) {
      expect(list.has(quoted), quoted).toBe(true);
    }
    expect(list.has('https://app.x.io/emailverification/other')).toBe(false);
    expect(list.has('https://app.x.io/')).toBe(false);
    // No temp files left behind.
    expect(fs.readdirSync(dir)).toEqual([path.basename(file)]);
  });

  it('dedupes, drops entries older than 14 days and keeps the newest 5000', () => {
    const now = 10 * FOREIGN_URLS_MAX_AGE_MS;
    recordForeignUrls(
      file,
      'https://old.x.io/a',
      now - FOREIGN_URLS_MAX_AGE_MS - 1,
    );
    recordForeignUrls(
      file,
      'https://kept.x.io/a https://kept.x.io/a',
      now - 1000,
    );
    recordForeignUrls(file, 'https://new.x.io/a', now);
    let list = readForeignUrls(file);
    expect(list.has('https://old.x.io/a')).toBe(false);
    expect(list.has('https://kept.x.io/a')).toBe(true);
    expect(list.has('https://new.x.io/a')).toBe(true);
    expect(fs.readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(2);

    const many = Array.from(
      { length: FOREIGN_URLS_MAX_ENTRIES + 10 },
      (_, i) => `https://bulk.x.io/item/${i}`,
    ).join('\n');
    recordForeignUrls(file, many, now + 1);
    expect(fs.readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(
      FOREIGN_URLS_MAX_ENTRIES,
    );
    list = readForeignUrls(file);
    expect(
      list.has(`https://bulk.x.io/item/${FOREIGN_URLS_MAX_ENTRIES + 9}`),
    ).toBe(true);
    expect(list.has('https://kept.x.io/a')).toBe(false);
  });

  it('fails closed on a list it did not write, and leaves such a list alone', () => {
    for (const bad of [
      'not json\n',
      '{"at":1}\n',
      '{"at":"x","k":["0123456789abcdef0123456789abcdef"]}\n',
    ]) {
      fs.writeFileSync(file, bad);
      expect(readForeignUrls(file).readable, bad).toBe(false);
      expect(() => recordForeignUrls(file, 'https://x.io/a')).toThrow();
      expect(fs.readFileSync(file, 'utf-8')).toBe(bad);
    }
    fs.rmSync(file);
    fs.symlinkSync(path.join(dir, 'elsewhere'), file);
    expect(readForeignUrls(file).readable).toBe(false);
  });
});

describe('createLinkCheckRun', () => {
  let dir: string;
  let noteFile: string;
  let foreignUrlsFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-check-run-'));
    noteFile = path.join(dir, '.codex-link-fix-note');
    foreignUrlsFile = foreignUrlsFilePath(dir);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function mcpRecords(run: { mcpEnv: Record<string, string> }, tool: string) {
    // Exactly what ipc-mcp-stdio does with the env it gets.
    const marker = foreignReadMarkerPath(
      dir,
      run.mcpEnv[FOREIGN_READ_MARKER_ENV],
    );
    expect(marker).not.toBeNull();
    recordForeignContentRead(marker!, tool);
  }

  const shared = (id: string | undefined) => ({ id, sharesChatThread: true });

  it('gives the MCP server nothing when the check is off', () => {
    const run = createLinkCheckRun({
      enabled: false,
      ipcDir: dir,
      noteFile,
      foreignUrlsFile,
      log: () => {},
    });
    expect(run.foreignReadMarker).toBeNull();
    expect(run.mcpEnv).toEqual({});
    expect(run.foreignContentReads()).toEqual([]);
  });

  it('turns itself off when the marker cannot be made', () => {
    const run = createLinkCheckRun({
      enabled: true,
      ipcDir: path.join(dir, 'missing'),
      noteFile,
      foreignUrlsFile,
      log: () => {},
    });
    expect(run.foreignReadMarker).toBeNull();
    expect(run.mcpEnv).toEqual({});
  });

  it('sees reads of this run and this user turn only', () => {
    const run = createLinkCheckRun({
      enabled: true,
      ipcDir: dir,
      noteFile,
      foreignUrlsFile,
      log: () => {},
    });
    const other = createLinkCheckRun({
      enabled: true,
      ipcDir: dir,
      noteFile,
      foreignUrlsFile,
      log: () => {},
    });
    expect(run.mcpEnv[FOREIGN_READ_MARKER_ENV]).not.toBe(
      other.mcpEnv[FOREIGN_READ_MARKER_ENV],
    );
    run.startUserTurn('что на почте?', shared('t1'));
    mcpRecords(run, 'gmail_get_thread');
    expect(run.foreignContentReads()).toEqual(['gmail_get_thread']);
    // A scheduled task of the same group next to it is not affected.
    expect(other.foreignContentReads()).toEqual([]);
    // The next user turn starts clean.
    run.startUserTurn('а теперь найди билеты', shared('t1'));
    expect(run.foreignContentReads()).toEqual([]);
    mcpRecords(run, 'chat_history');
    run.close();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('turns itself off when the group dir cannot keep the foreign-link list', () => {
    const log = vi.fn();
    const run = createLinkCheckRun({
      enabled: true,
      ipcDir: dir,
      noteFile,
      foreignUrlsFile: foreignUrlsFilePath(path.join(dir, 'missing')),
      log,
    });
    expect(run.foreignReadMarker).toBeNull();
    expect(run.mcpEnv).toEqual({});
    expect(log.mock.calls.join('\n')).toContain('foreign links');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('never probes a mail link the thread quotes on a later turn or in a later run', async () => {
    const T = 1_000_000;
    const MAIL_LINK = 'https://app.x.io/emailverification/Q2x9abcDEF';
    const PLAIN_LINK = 'https://app.x.io/onboarding/step-2';
    const run = createLinkCheckRun({
      enabled: true,
      ipcDir: dir,
      noteFile,
      foreignUrlsFile,
      log: () => {},
    });
    // Turn 1: the model reads the mail; the MCP server records both.
    run.startUserTurn('что нового на почте?', shared('t1'));
    mcpRecords(run, 'gmail_get_thread');
    recordForeignUrls(
      foreignUrlsFile,
      JSON.stringify({
        bodyText: `Подтвердите почту: ${MAIL_LINK}\nНачните тут: ${PLAIN_LINK}`,
      }),
    );
    const fetchImpl = fakeFetch(() => resp(200));
    const check = (
      linkRun: ReturnType<typeof createLinkCheckRun>,
      text: string,
    ) =>
      applyLinkCheck({
        text,
        promptText: linkRun.promptLinks(),
        mode: 'shadow',
        foreignContentReads: linkRun.foreignContentReads,
        foreignUrls: linkRun.foreignUrls,
        turnDeadlineAt: T + 600_000,
        deps: deps({ fetchImpl: fetchImpl as unknown as typeof fetch }),
        runCorrection: vi.fn(),
        log: () => {},
        now: () => T,
      });
    // Turn 2, piped: nothing read now, the link comes from the thread.
    run.startUserTurn('скинь ссылку из письма', shared('t1'));
    expect(run.foreignContentReads()).toEqual([]);
    const turn2 = await check(run, `Вот: ${MAIL_LINK} и ${PLAIN_LINK}`);
    expect(turn2.summary).toMatchObject({
      found: 2,
      checked: 0,
      reasons: { 'skip:foreign-url': 2 },
    });
    run.close();
    // The next run of the same chat resumes the same thread.
    const next = createLinkCheckRun({
      enabled: true,
      ipcDir: dir,
      noteFile,
      foreignUrlsFile,
      log: () => {},
    });
    next.startUserTurn('открой ту ссылку', shared('t1'));
    const turn3 = await check(next, `Открываю: ${PLAIN_LINK}`);
    expect(turn3.summary).toMatchObject({
      checked: 0,
      reasons: { 'skip:foreign-url': 1 },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    // A link the chat never read from foreign text is still probed.
    await check(next, 'Билеты: https://www.tutu.ru/poezda/Mineralnye_Vody/');
    expect(fetchImpl).toHaveBeenCalled();
    next.close();
  });

  it('keeps the links of every prompt of the run', () => {
    const run = createLinkCheckRun({
      enabled: true,
      ipcDir: dir,
      noteFile,
      foreignUrlsFile,
      log: () => {},
    });
    run.startUserTurn(
      '<recent_conversation_context>Иван: https://a.kz/old</recent_conversation_context>\nИван: https://a.kz/first',
      shared('t1'),
    );
    run.addPrompt('Иван: и https://a.kz/burst');
    run.startUserTurn('Иван: сделай план', shared('t1'));
    for (const url of [
      'https://a.kz/old',
      'https://a.kz/first',
      'https://a.kz/burst',
    ]) {
      expect(linkSkipReason(url, run.promptLinks()), url).toBe('in-prompt');
    }
    expect(linkSkipReason('https://a.kz/new', run.promptLinks())).toBeNull();
  });

  it('tells the thread once that its link correction never reached the user', () => {
    const run = createLinkCheckRun({
      enabled: true,
      ipcDir: dir,
      noteFile,
      foreignUrlsFile,
      log: () => {},
    });
    for (const correction of ['rejected', 'failed']) {
      run.afterCheck(
        { correction },
        { sharesChatThread: true, fixThreadId: 't1', threadId: 't1' },
      );
      // The next turn usually comes in a new run.
      const next = createLinkCheckRun({
        enabled: false,
        ipcDir: dir,
        noteFile,
        foreignUrlsFile,
        log: () => {},
      });
      expect(next.startUserTurn('открой вторую ссылку', shared('t1'))).toBe(
        `${LINK_FIX_DISCARDED_NOTE}\n\nоткрой вторую ссылку`,
      );
      expect(next.startUserTurn('и третью', shared('t1'))).toBe('и третью');
    }
  });

  it('leaves no note when the correction was applied or never ran', () => {
    const run = createLinkCheckRun({
      enabled: true,
      ipcDir: dir,
      noteFile,
      foreignUrlsFile,
      log: () => {},
    });
    for (const correction of [
      'applied',
      'shadow',
      'skipped-mark-mode',
      'skipped-budget',
      'skipped-foreign-content',
    ]) {
      run.afterCheck(
        { correction },
        { sharesChatThread: true, fixThreadId: 't1', threadId: 't1' },
      );
    }
    expect(fs.existsSync(noteFile)).toBe(false);
    run.afterCheck(
      { correction: 'rejected' },
      { sharesChatThread: false, fixThreadId: 't1', threadId: 't1' },
    );
    run.afterCheck(
      { correction: 'rejected' },
      { sharesChatThread: true, fixThreadId: undefined, threadId: undefined },
    );
    expect(fs.existsSync(noteFile)).toBe(false);
  });

  it('keeps the note for the chat thread and drops it for another thread', () => {
    const run = createLinkCheckRun({
      enabled: false,
      ipcDir: dir,
      noteFile,
      foreignUrlsFile,
      log: () => {},
    });
    run.afterCheck(
      { correction: 'rejected' },
      { sharesChatThread: true, fixThreadId: 't1', threadId: 't1' },
    );
    // A scheduled task on its own thread does not take it.
    expect(
      run.startUserTurn('задача', { id: 'task', sharesChatThread: false }),
    ).toBe('задача');
    expect(fs.existsSync(noteFile)).toBe(true);
    // The chat thread was rotated meanwhile: the new one never saw anything.
    expect(run.startUserTurn('привет', shared('t2'))).toBe('привет');
    expect(fs.existsSync(noteFile)).toBe(false);
  });
});

describe('link fix note files', () => {
  it('knows which corrections were discarded', () => {
    expect(linkFixDiscarded({ correction: 'rejected' })).toBe(true);
    expect(linkFixDiscarded({ correction: 'failed' })).toBe(true);
    expect(linkFixDiscarded({ correction: 'applied' })).toBe(false);
    expect(linkFixDiscarded(undefined)).toBe(false);
  });

  it('reads a note once, for its own thread only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-fix-note-'));
    try {
      const file = path.join(dir, 'note');
      expect(takeLinkFixNote(file, 't1')).toBe('');
      saveLinkFixNote(file, 't1');
      expect(takeLinkFixNote(file, 't1')).toBe(LINK_FIX_DISCARDED_NOTE);
      expect(takeLinkFixNote(file, 't1')).toBe('');
      saveLinkFixNote(file, 't1');
      expect(takeLinkFixNote(file, undefined)).toBe('');
      expect(fs.existsSync(file)).toBe(false);
      fs.writeFileSync(file, 'not json');
      expect(takeLinkFixNote(file, 't1')).toBe('');
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('proxyConfiguredInEnv', () => {
  it('sees any spelling of a proxy variable', () => {
    expect(proxyConfiguredInEnv({})).toBe(false);
    expect(proxyConfiguredInEnv({ HTTPS_PROXY: 'http://127.0.0.1:1' })).toBe(
      true,
    );
    expect(proxyConfiguredInEnv({ all_proxy: 'socks5://x' })).toBe(true);
    expect(proxyConfiguredInEnv({ HTTPS_PROXY: '' })).toBe(false);
  });
});
