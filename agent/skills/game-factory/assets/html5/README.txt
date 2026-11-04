Lantern Garden — original reusable Canvas starter

An intentionally small complete loop: collect five lights, return to the
lantern within 24 moves, win or lose, retry. Artwork and short sounds are
procedural; no private game, third-party art, personal data or credentials.

Run with any local HTTP static server (ES modules require HTTP), then open
index.html. All input paths are ordinary player controls: arrow keys/WASD,
adjacent tile click/tap and on-screen directional buttons. Escape/manual
pause, visibility and platform pause reasons compose independently.

Save schema 2 stores a validated round, best moves, wins, mute and language.
Schema 1 {version:1,best,sound,lang} migrates locally. Corrupt/future saves
start safely; blocked localStorage does not prevent play. This is local
browser storage only, not cloud save. Each package has its own save key.

Profiles created by create-html5.mjs:
- local: no SDK/network dependency.
- yandex: loads /sdk.js, awaits YaGames.init, calls LoadingAPI.ready after
  controls are ready, pairs GameplayAPI.start/stop with actual play, and
  handles game_api_pause/game_api_resume. SDK failure is visible and stops
  startup. No ads, payments, publishing or account login.
- crazygames-basic: intentionally SDK-free Basic candidate. No ads or
  account/payment calls. Full SDK monetization is a separate integration.

Verified official references, 2026-11-04:
https://yandex.com/dev/games/doc/en/sdk/sdk-about
https://yandex.com/dev/games/doc/en/sdk/sdk-game-events
https://yandex.com/dev/games/doc/en/sdk/sdk-events
https://docs.crazygames.com/general/basic-launch-guide/
https://docs.crazygames.com/sdk/intro/

Local browser tests cover this loop, save migration and fixture SDK calls.
A fixture is not a portal test, moderation approval, SDK account access,
mobile hardware test, commercial-quality review or publishing permission.
Before releasing a real game: adapt its own brief, art and acceptance,
test on actual devices and portals, provide media and verify asset rights.
