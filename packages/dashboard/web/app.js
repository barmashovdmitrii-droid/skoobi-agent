/* Локальный интерфейс Скуби. Чистый JS, без внешних библиотек. */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c],
    );

  let activeTab = 'pult';
  const timers = [];

  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (res.status === 401) {
      location.reload();
      throw new Error('нужен вход');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new Error(body.message || body.error || 'ошибка запроса');
    return body;
  }

  function toast(text, ok = true) {
    const el = $('#toast');
    el.textContent = (ok ? '✓ ' : '⚠ ') + text;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(() => {
      el.hidden = true;
    }, 3500);
  }

  async function action(type, params, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return null;
    try {
      const r = await api('/api/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, params }),
      });
      toast(r.message, true);
      return r;
    } catch (err) {
      toast(err.message, false);
      return null;
    }
  }

  const ICONS = {
    message: '💬',
    check: '✅',
    cpu: '⚙️',
    flag: '🏁',
    sparkles: '✨',
    coin: '🪙',
    bolt: '⚡',
    alert: '❗',
    refresh: '🔄',
    dot: '·',
  };

  /* ── Пульт ── */
  async function renderPult() {
    const data = await api('/api/overview');
    $('#services').innerHTML = data.services
      .map(
        (s) => `
      <div class="card">
        <div class="name"><span class="dot ${s.state}"></span>${esc(s.name)}</div>
        <div class="detail">${esc(s.detail)}</div>
      </div>`,
      )
      .join('');
    const n = data.numbers;
    $('#numbers').innerHTML = `
      <div class="metric"><div class="label">Событий за 5 минут</div>
        <div class="value">${n.events5m}</div></div>
      <div class="metric"><div class="label">Задач на сегодня</div>
        <div class="value">${n.tasksToday}</div></div>
      <div class="metric"><div class="label">Ошибок за сутки</div>
        <div class="value ${n.errors24h ? 'bad' : 'good'}">${n.errors24h}</div></div>`;
    // Бейдж «ошибок за сутки» считается по журналу событий и может пережить
    // ротацию лога — поэтому сами ошибки показываем тут же, а не отсылаем
    // пользователя искать их в «Журнале».
    const errs = data.errors || [];
    $('#errors-wrap').hidden = errs.length === 0;
    $('#errors').innerHTML = errs
      .map(
        (e) => `
      <div class="row"><span>❗</span>
        <span class="grow">${esc(e.text)}</span>
        <span class="time">${esc(e.time)}</span></div>`,
      )
      .join('');
    $('#events').innerHTML =
      data.events
        .map(
          (e) => `
      <div class="row"><span>${ICONS[e.icon] || '·'}</span>
        <span class="grow">${esc(e.text)}</span>
        <span class="time">${esc(e.time)}</span></div>`,
        )
        .join('') ||
      '<div class="row"><span class="grow sub">Событий пока нет — тишина.</span></div>';
    const down = data.services.filter((s) => s.state === 'down').length;
    const warn = data.services.filter((s) => s.state === 'warn').length;
    const pill = $('#health-pill');
    if (down) {
      pill.textContent = 'есть проблемы';
      pill.className = 'pill warn';
    } else if (n.errors24h) {
      pill.textContent = `ошибок за сутки: ${n.errors24h}`;
      pill.className = 'pill warn';
    } else {
      pill.textContent = warn ? 'почти всё спокойно' : 'всё спокойно';
      pill.className = 'pill ok';
    }
  }

  /* ── Диалоги: Telegram + локальный WhatsApp observer ── */
  const MEDIA = {
    voice: { icon: '◉', label: 'Голосовое' },
    audio: { icon: '♪', label: 'Аудио' },
    image: { icon: '▧', label: 'Фото' },
    video: { icon: '▶', label: 'Видео' },
    'video-note': { icon: '◉', label: 'Видеосообщение' },
    document: { icon: '▤', label: 'Документ' },
    other: { icon: '◇', label: 'Вложение' },
  };
  let allChats = [];
  let selectedJid = null;
  let dialogFilter = 'all';
  let dialogRequestSeq = 0;
  let dialogSearchSeq = 0;
  let dialogSearchTimer = null;
  let dialogSearchResults = [];
  let dialogSearchLoading = false;
  let dialogSearchError = '';
  let dialogPage = emptyDialogPage();
  let chatSending = false;
  let contactPanelJid = null;
  let contactLinkTargetJid = null;
  let contactPickerResults = [];
  let contactPickerActiveIndex = -1;

  function emptyDialogPage(jid = '') {
    return {
      jid,
      messages: [],
      hasMore: false,
      nextCursor: null,
      anchored: false,
      focusAnchor: null,
      loadedOlder: false,
    };
  }

  function mediaInfo(kind) {
    return MEDIA[kind] || MEDIA.other;
  }

  function dayKey(iso) {
    const date = new Date(iso);
    return Number.isFinite(date.getTime())
      ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
      : '';
  }

  function dayLabel(iso) {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return '';
    const now = new Date();
    const today = dayKey(now.toISOString());
    const yesterdayDate = new Date(now);
    yesterdayDate.setDate(now.getDate() - 1);
    const yesterday = dayKey(yesterdayDate.toISOString());
    const key = dayKey(iso);
    if (key === today) return 'Сегодня';
    if (key === yesterday) return 'Вчера';
    return date.toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    });
  }

  function messageText(text) {
    const value = String(text || '').trim() || 'Без подписи';
    if (value.length <= 900) {
      return `<div class="message-text">${esc(value)}</div>`;
    }
    return `<div class="message-text">${esc(value.slice(0, 900))}…</div>
      <details class="message-more"><summary>Показать полностью</summary>
        <div class="message-full">${esc(value)}</div>
      </details>`;
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
    return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} МБ`;
  }

  function mediaUrl(jid, anchor, mediaId) {
    const params = new URLSearchParams({ jid, anchor, mediaId });
    return `/api/dialog-media?${params.toString()}`;
  }

  function renderMessageMedia(message, chat) {
    const items = Array.isArray(message.media) ? message.media : [];
    if (!message.anchor || items.length === 0) {
      return `<div class="media-unavailable">
        <span aria-hidden="true">◇</span>
        <span>Исходный файл не найден в локальном хранилище.</span>
      </div>`;
    }
    return `<div class="media-files">${items
      .map((item) => {
        const kind = ['image', 'audio', 'video', 'document'].includes(item.kind)
          ? item.kind
          : 'document';
        const label = String(item.label || mediaInfo(message.kind).label);
        const size = formatBytes(item.sizeBytes);
        const url = mediaUrl(chat.jid, message.anchor, item.mediaId);
        const meta = `${label}${size ? ` · ${size}` : ''}`;
        const download = `<a class="media-download" href="${esc(url)}" download aria-label="Скачать ${esc(label.toLocaleLowerCase('ru-RU'))}">Скачать</a>`;
        if (kind === 'image') {
          return `<figure class="media-file media-image">
            <img class="media-preview" src="${esc(url)}" alt="${esc(label)}" loading="lazy" />
            <figcaption><span>${esc(meta)}</span>${download}</figcaption>
            <div class="media-load-error" hidden>Фото больше не доступно локально.</div>
          </figure>`;
        }
        if (kind === 'audio') {
          return `<div class="media-file media-audio">
            <audio class="media-preview" src="${esc(url)}" controls preload="metadata" aria-label="${esc(label)}"></audio>
            <span class="media-file-meta">${esc(meta)}${download}</span>
            <div class="media-load-error" hidden>Аудиофайл больше не доступен локально.</div>
          </div>`;
        }
        if (kind === 'video') {
          return `<div class="media-file media-video">
            <video class="media-preview" src="${esc(url)}" controls preload="metadata" playsinline aria-label="${esc(label)}"></video>
            <span class="media-file-meta">${esc(meta)}${download}</span>
            <div class="media-load-error" hidden>Видеофайл больше не доступен локально.</div>
          </div>`;
        }
        return `<a class="media-file media-document" href="${esc(url)}" download>
          <span class="media-document-icon" aria-hidden="true">▤</span>
          <span><strong>${esc(label)}</strong>${size ? `<small>${esc(size)}</small>` : ''}</span>
          <span aria-hidden="true">↓</span>
        </a>`;
      })
      .join('')}</div>`;
  }

  function bindMediaErrors(target) {
    target.querySelectorAll('.media-preview').forEach((preview) => {
      preview.addEventListener('error', () => {
        const file = preview.closest('.media-file');
        const error = file?.querySelector('.media-load-error');
        preview.hidden = true;
        if (file) file.classList.add('failed');
        if (error) error.hidden = false;
      });
    });
    target.querySelectorAll('.media-document').forEach((link) => {
      link.addEventListener('click', async (event) => {
        event.preventDefault();
        if (link.getAttribute('aria-disabled') === 'true') return;
        link.classList.add('loading');
        try {
          const response = await fetch(link.href, { method: 'HEAD' });
          if (!response.ok) throw new Error('media unavailable');
          const download = document.createElement('a');
          download.href = link.href;
          download.download = '';
          document.body.append(download);
          download.click();
          download.remove();
        } catch {
          link.removeAttribute('href');
          link.removeAttribute('download');
          link.setAttribute('aria-disabled', 'true');
          link.classList.add('failed');
          link.textContent = 'Документ больше не доступен локально.';
        } finally {
          link.classList.remove('loading');
        }
      });
    });
  }

  function renderDialogMessages(messages, chat, anchored = false) {
    let lastDay = '';
    const parts = [];
    for (const message of messages) {
      const key = dayKey(message.isoTime);
      if (key && key !== lastDay) {
        parts.push(
          `<div class="date-separator">${esc(dayLabel(message.isoTime))}</div>`,
        );
        lastDay = key;
      }
      const kind = String(message.kind || 'text');
      const localFiles = Array.isArray(message.media)
        ? message.media.length
        : 0;
      const media = kind !== 'text' || localFiles > 0;
      const info = mediaInfo(kind !== 'text' ? kind : message.media?.[0]?.kind);
      const status = media
        ? `<span class="media-status ${localFiles ? 'ready' : ''}">${
            localFiles
              ? 'файл доступен локально'
              : message.mediaEnriched
                ? 'разобрано · без исходника'
                : 'файл недоступен'
          }</span>`
        : '';
      parts.push(`
        <div class="msg ${message.outgoing ? 'outgoing' : ''} ${message.fromBot ? 'bot' : ''} ${media ? 'media-card' : ''} ${message.anchor === dialogPage.focusAnchor ? 'focused-message' : ''}" data-anchor="${esc(message.anchor || '')}">
          <div class="who">${esc(message.sender)} · ${esc(message.time)}</div>
          ${
            media
              ? `<div class="media-heading"><span class="media-label"><span aria-hidden="true">${info.icon}</span>${info.label}</span>${status}</div>`
              : ''
          }
          ${media ? renderMessageMedia(message, chat) : ''}
          ${messageText(message.text)}
        </div>`);
    }
    const last = messages[messages.length - 1];
    const lastAt = last?.isoTime ? new Date(last.isoTime).getTime() : NaN;
    if (
      !anchored &&
      chat.canSend &&
      last &&
      !last.fromBot &&
      Number.isFinite(lastAt) &&
      Date.now() - lastAt < 5 * 60_000
    ) {
      parts.push(
        '<div class="msg outgoing bot thinking"><div class="who">Скуби</div>думает…</div>',
      );
    }
    return (
      parts.join('') ||
      '<div class="dialog-list-empty">Сообщений пока нет.</div>'
    );
  }

  function renderWhatsAppStatus(status) {
    const target = $('#whatsapp-status');
    if (!status) {
      target.className = 'whatsapp-status warn';
      target.innerHTML = `<span class="dot warn" aria-hidden="true"></span>
        <div><strong>WhatsApp · локальная синхронизация Скуби</strong>
          <p>Статус локального хранилища сейчас недоступен.</p>
          <small>Это собственный канал Скуби на Mac mini, а не синхронизация вкладки Chrome.</small>
        </div>`;
      return;
    }
    const state = ['ok', 'warn', 'down'].includes(status.state)
      ? status.state
      : 'warn';
    target.className = `whatsapp-status ${state}`;
    target.innerHTML = `<span class="dot ${state}" aria-hidden="true"></span>
      <div class="whatsapp-status-copy">
        <strong>WhatsApp · локальная синхронизация Скуби</strong>
        <p>${esc(status.detail)}</p>
        <small>Это собственный канал Скуби на Mac mini, а не синхронизация вкладки Chrome.</small>
      </div>
      <div class="whatsapp-status-counts" aria-label="Данные WhatsApp за сутки">
        <span><b>${Number(status.messages24h) || 0}</b> сообщений</span>
        <span><b>${Number(status.media24h) || 0}</b> медиа</span>
        <span class="${status.unprocessedMedia ? 'pending' : ''}"><b>${Number(status.unprocessedMedia) || 0}</b> без разбора за сутки</span>
      </div>`;
  }

  function filteredChats() {
    const query = $('#dialog-search').value.trim().toLocaleLowerCase('ru-RU');
    return allChats.filter((chat) => {
      const matchesQuery =
        !query ||
        [chat.name, chat.preview, chat.lastSender]
          .join(' ')
          .toLocaleLowerCase('ru-RU')
          .includes(query);
      if (!matchesQuery) return false;
      if (dialogFilter === 'telegram') return chat.channel === 'telegram';
      if (dialogFilter === 'whatsapp') return chat.channel === 'whatsapp';
      if (dialogFilter === 'media') {
        return chat.media24h > 0 || chat.lastKind !== 'text';
      }
      if (dialogFilter === 'active') return chat.messages24h > 0;
      if (dialogFilter === 'important') {
        return Boolean(chat.pinned || chat.needsReply);
      }
      return true;
    });
  }

  function renderDialogStats() {
    const telegram = allChats.filter(
      (chat) => chat.channel === 'telegram',
    ).length;
    const whatsapp = allChats.filter(
      (chat) => chat.channel === 'whatsapp',
    ).length;
    const active = allChats.filter((chat) => chat.messages24h > 0).length;
    const media = allChats.reduce((sum, chat) => sum + chat.media24h, 0);
    const important = allChats.filter(
      (chat) => chat.pinned || chat.needsReply,
    ).length;
    $('#dialog-stats').innerHTML = `
      <div class="dialog-stat"><strong>${allChats.length}</strong><span>всего</span></div>
      <div class="dialog-stat"><strong>${active}</strong><span>активны за сутки</span></div>
      <div class="dialog-stat"><strong>${telegram}</strong><span>Telegram · ${whatsapp} WhatsApp</span></div>
      <div class="dialog-stat"><strong>${media}</strong><span>медиа за сутки</span></div>
      <div class="dialog-stat"><strong>${important}</strong><span>важные</span></div>`;
  }

  async function toggleChatPause(jid, paused) {
    const ok = await action(
      'chat_pause',
      { jid, value: !paused },
      paused
        ? null
        : 'Поставить чат на паузу? Скуби перестанет отвечать в нём.',
    );
    if (ok) await renderChats();
  }

  async function toggleDialogPin(jid, pinned) {
    const ok = await action('dialog_pin', { jid, value: !pinned });
    if (ok) await renderChats();
  }

  function formatSearchTime(iso) {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return '';
    return date.toLocaleString('ru-RU', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function renderDialogSearchResults() {
    const target = $('#dialog-search-results');
    const query = $('#dialog-search').value.trim();
    const searchingHistory = Array.from(query).length >= 2;
    $('#chats').hidden = searchingHistory;
    if (!searchingHistory) {
      target.hidden = true;
      target.innerHTML = '';
      return;
    }
    target.hidden = false;
    if (dialogSearchLoading) {
      target.innerHTML =
        '<div class="search-state">Ищу по всей локальной истории…</div>';
      return;
    }
    if (dialogSearchError) {
      target.innerHTML = `<div class="search-state error">${esc(dialogSearchError)}</div>`;
      return;
    }
    target.innerHTML = `<div class="search-results-title">Сообщения <span>${dialogSearchResults.length}</span></div>${
      dialogSearchResults.length
        ? dialogSearchResults
            .map((result) => {
              const info = mediaInfo(result.kind);
              return `<button class="search-result" type="button" data-jid="${esc(result.jid)}" data-anchor="${esc(result.anchor)}">
                  <span class="search-result-head"><strong>${esc(result.chatName)}</strong><small>${result.channel === 'telegram' ? 'TG' : 'WA'} · ${esc(formatSearchTime(result.isoTime))}</small></span>
                  <span class="search-result-snippet">${result.kind !== 'text' ? `<span aria-hidden="true">${info.icon}</span> ` : ''}<b>${esc(result.sender)}:</b> ${esc(result.snippet)}</span>
                </button>`;
            })
            .join('')
        : '<div class="search-state">В истории совпадений нет.</div>'
    }`;
    target.querySelectorAll('.search-result').forEach((button) => {
      button.addEventListener('click', () => {
        selectDialog(button.dataset.jid, true, {
          anchor: button.dataset.anchor,
        }).catch((err) => toast(err.message, false));
      });
    });
  }

  async function runDialogSearch() {
    const query = $('#dialog-search').value.trim();
    const seq = ++dialogSearchSeq;
    if (Array.from(query).length < 2) {
      dialogSearchResults = [];
      dialogSearchLoading = false;
      dialogSearchError = '';
      renderDialogSearchResults();
      return;
    }
    dialogSearchLoading = true;
    dialogSearchError = '';
    renderDialogSearchResults();
    try {
      const params = new URLSearchParams({
        q: query,
        limit: '50',
        filter: dialogFilter,
      });
      const data = await api(`/api/dialog-search?${params.toString()}`);
      if (seq !== dialogSearchSeq) return;
      dialogSearchResults = data.results || [];
    } catch (err) {
      if (seq !== dialogSearchSeq) return;
      dialogSearchResults = [];
      dialogSearchError = err.message || 'Поиск временно недоступен';
    } finally {
      if (seq === dialogSearchSeq) {
        dialogSearchLoading = false;
        renderDialogSearchResults();
      }
    }
  }

  function queueDialogSearch() {
    dialogSearchSeq += 1;
    renderDialogList();
    clearTimeout(dialogSearchTimer);
    dialogSearchTimer = setTimeout(runDialogSearch, 280);
    const query = $('#dialog-search').value.trim();
    if (Array.from(query).length < 2) {
      dialogSearchResults = [];
      dialogSearchLoading = false;
      dialogSearchError = '';
      renderDialogSearchResults();
    }
  }

  function renderDialogList() {
    const searchingHistory =
      Array.from($('#dialog-search').value.trim()).length >= 2;
    $('#chats').hidden = searchingHistory;
    const visible = filteredChats();
    $('#chats').innerHTML =
      visible
        .map((chat) => {
          const media =
            chat.lastKind !== 'text' ? mediaInfo(chat.lastKind) : null;
          return `<div class="dialog-item ${chat.jid === selectedJid ? 'selected' : ''}">
            <button class="dialog-open" data-jid="${esc(chat.jid)}" aria-selected="${chat.jid === selectedJid}">
              <span class="dialog-name-line">
                <span class="dialog-name">${esc(chat.name)}</span>
                <span class="channel-badge ${chat.channel}">${chat.channel === 'telegram' ? 'TG' : 'WA'}</span>
                ${chat.canSend ? '<span class="state-badge main">Скуби</span>' : ''}
                ${chat.paused ? '<span class="state-badge paused">пауза</span>' : ''}
                ${chat.pinned ? '<span class="state-badge pinned">важное</span>' : ''}
              </span>
              <span class="dialog-time">${esc(chat.lastMessageAgo)}</span>
              <span class="dialog-preview">${media ? `<span aria-hidden="true">${media.icon}</span> ` : ''}<strong>${esc(chat.lastSender)}:</strong> ${esc(chat.preview)}</span>
              <span class="dialog-counts">${chat.messages24h ? `${chat.messages24h} за сутки` : ''}${chat.media24h ? ` · ${chat.media24h} медиа` : ''}</span>
              ${chat.needsReply ? `<span class="attention-badge">${esc(chat.attentionReason || 'Ждёт ответа')}</span>` : ''}
            </button>
            <div class="dialog-item-actions">
              <button class="dialog-pin-mini" type="button" data-jid="${esc(chat.jid)}" data-pinned="${chat.pinned ? '1' : '0'}" aria-pressed="${Boolean(chat.pinned)}" aria-label="${chat.pinned ? 'Открепить диалог' : 'Закрепить диалог'}" title="${chat.pinned ? 'Открепить' : 'Закрепить'}">${chat.pinned ? '★' : '☆'}</button>
              ${chat.canPause ? `<button class="dialog-pause-mini" type="button" data-jid="${esc(chat.jid)}" data-paused="${chat.paused ? '1' : '0'}" aria-label="${chat.paused ? 'Вернуть чат' : 'Поставить чат на паузу'}" title="${chat.paused ? 'Вернуть чат' : 'Поставить на паузу'}">${chat.paused ? '▶' : '⏸'}</button>` : ''}
            </div>
          </div>`;
        })
        .join('') ||
      '<div class="dialog-list-empty">Ничего не найдено. Попробуй другой запрос или фильтр.</div>';

    $('#chats')
      .querySelectorAll('.dialog-open')
      .forEach((button) => {
        button.addEventListener('click', () => {
          selectDialog(button.dataset.jid, true).catch((err) =>
            toast(err.message, false),
          );
        });
      });
    $('#chats')
      .querySelectorAll('.dialog-pin-mini')
      .forEach((button) => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          toggleDialogPin(
            button.dataset.jid,
            button.dataset.pinned === '1',
          ).catch((err) => toast(err.message, false));
        });
      });
    $('#chats')
      .querySelectorAll('.dialog-pause-mini')
      .forEach((button) => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          toggleChatPause(
            button.dataset.jid,
            button.dataset.paused === '1',
          ).catch((err) => toast(err.message, false));
        });
      });
  }

  function contactOptionLabel(chat) {
    return `${chat.channel === 'telegram' ? 'TG' : 'WA'} · ${chat.name}`;
  }

  function contactLinkCandidates(chat) {
    const linkedJids = new Set(
      (Array.isArray(chat.linkedChats) ? chat.linkedChats : []).map(
        (item) => item.jid,
      ),
    );
    return allChats
      .filter((item) => item.jid !== chat.jid && !linkedJids.has(item.jid))
      .sort((a, b) => {
        const aOther = a.channel !== chat.channel ? 0 : 1;
        const bOther = b.channel !== chat.channel ? 0 : 1;
        return aOther - bOther || a.name.localeCompare(b.name, 'ru');
      });
  }

  function closeContactPicker() {
    const input = $('#contact-link-search');
    const options = $('#contact-link-options');
    options.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    contactPickerActiveIndex = -1;
  }

  function selectContactCandidate(chat) {
    if (!chat) return;
    contactLinkTargetJid = chat.jid;
    $('#contact-link-search').value = contactOptionLabel(chat);
    $('#contact-link-add').disabled = false;
    closeContactPicker();
  }

  function updateContactPicker(chat, open = false) {
    const input = $('#contact-link-search');
    const options = $('#contact-link-options');
    const query = input.value.trim().toLocaleLowerCase('ru-RU');
    contactPickerResults = contactLinkCandidates(chat)
      .filter((item) => {
        if (!query || item.jid === contactLinkTargetJid) return true;
        return [item.name, item.sourceName, item.channelLabel]
          .join(' ')
          .toLocaleLowerCase('ru-RU')
          .includes(query);
      })
      .slice(0, 10);
    contactPickerActiveIndex = Math.min(
      contactPickerActiveIndex,
      contactPickerResults.length - 1,
    );
    options.innerHTML = contactPickerResults
      .map(
        (item, index) => `<button
          id="contact-link-option-${index}"
          class="contact-picker-option${index === contactPickerActiveIndex ? ' active' : ''}"
          type="button"
          role="option"
          tabindex="-1"
          aria-selected="${item.jid === contactLinkTargetJid}"
          data-jid="${esc(item.jid)}"
        >
          <span class="channel-badge ${item.channel}">${item.channel === 'telegram' ? 'TG' : 'WA'}</span>
          <span>${esc(item.name)}</span>
        </button>`,
      )
      .join('');
    const expanded = open && contactPickerResults.length > 0;
    options.hidden = !expanded;
    input.setAttribute('aria-expanded', String(expanded));
    if (expanded && contactPickerActiveIndex >= 0) {
      const activeId = `contact-link-option-${contactPickerActiveIndex}`;
      input.setAttribute('aria-activedescendant', activeId);
      options
        .querySelector(`#${activeId}`)
        ?.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
    options.querySelectorAll('.contact-picker-option').forEach((button) => {
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        selectContactCandidate(
          contactPickerResults.find((item) => item.jid === button.dataset.jid),
        );
      });
    });
  }

  function captureContactDraft(jid) {
    if (!jid || contactPanelJid !== jid) return null;
    return {
      jid,
      alias: $('#contact-alias').value,
      pickerQuery: $('#contact-link-search').value,
      targetJid: contactLinkTargetJid,
      panelOpen: !$('#contact-panel').hidden,
    };
  }

  function renderContactPanel(chat, draft = null) {
    const sameDraft = draft?.jid === chat.jid;
    contactPanelJid = chat.jid;
    $('#contact-alias').value = sameDraft ? draft.alias : chat.localAlias || '';
    const sourceName = $('#contact-source-name');
    sourceName.textContent = chat.localAlias
      ? `Имя в мессенджере: ${chat.sourceName || 'не указано'}`
      : '';
    sourceName.hidden = !chat.localAlias;
    const linked = Array.isArray(chat.linkedChats) ? chat.linkedChats : [];
    $('#contact-links').innerHTML = linked.length
      ? linked
          .map(
            (item) => `<div class="contact-link">
              <button class="contact-link-open" type="button" data-jid="${esc(item.jid)}">
                <span class="channel-badge ${item.channel}">${item.channel === 'telegram' ? 'TG' : 'WA'}</span>
                <span>${esc(item.name)}</span>
              </button>
              <button class="contact-unlink" type="button" data-jid="${esc(item.jid)}" aria-label="Отвязать ${esc(item.name)}" title="Убрать связь">×</button>
            </div>`,
          )
          .join('')
      : '<span class="contact-empty">Связанных диалогов пока нет.</span>';
    const candidates = contactLinkCandidates(chat);
    contactLinkTargetJid = sameDraft
      ? candidates.find((item) => item.jid === draft.targetJid)?.jid || null
      : null;
    const picker = $('#contact-link-search');
    picker.value = sameDraft ? draft.pickerQuery : '';
    picker.disabled = candidates.length === 0;
    picker.placeholder = candidates.length
      ? 'Найти Telegram или WhatsApp…'
      : 'Нет других диалогов';
    $('#contact-link-add').disabled = !contactLinkTargetJid;
    updateContactPicker(chat, false);
    if (sameDraft && draft.panelOpen) {
      $('#contact-panel').hidden = false;
      $('#chat-contact').setAttribute('aria-expanded', 'true');
    }

    $('#contact-links')
      .querySelectorAll('.contact-link-open')
      .forEach((button) => {
        button.addEventListener('click', () => {
          selectDialog(button.dataset.jid, true).catch((err) =>
            toast(err.message, false),
          );
        });
      });
    $('#contact-links')
      .querySelectorAll('.contact-unlink')
      .forEach((button) => {
        button.addEventListener('click', async () => {
          const ok = await action('dialog_link', {
            jid: chat.jid,
            targetJid: button.dataset.jid,
            value: false,
          });
          if (ok) await renderChats();
        });
      });
  }

  function showDialogHeader(chat, contactDraft = null) {
    $('#dialog-empty').hidden = true;
    $('#dialog-content').hidden = false;
    $('#chat-title').textContent = chat.name;
    $('#chat-meta').textContent = [
      chat.channelLabel,
      chat.isGroup ? 'группа' : 'личный диалог',
      `${chat.messagesTotal} сообщений`,
      chat.paused
        ? 'на паузе'
        : chat.readOnly
          ? 'просмотр'
          : 'можно писать здесь',
    ].join(' · ');
    $('#chat-compose').hidden = !chat.canSend || chat.paused;
    const readonly = $('#dialog-readonly');
    readonly.hidden = !chat.readOnly && !chat.paused;
    readonly.textContent = chat.paused
      ? 'Этот чат на паузе. Верни его, чтобы снова писать Скуби.'
      : 'Этот диалог доступен для просмотра. Отвечай в самом мессенджере.';
    const pause = $('#chat-pause');
    pause.hidden = !chat.canPause;
    pause.dataset.jid = chat.jid;
    pause.dataset.paused = chat.paused ? '1' : '0';
    pause.textContent = chat.paused ? 'Вернуть чат' : 'Поставить на паузу';
    const pin = $('#chat-pin');
    pin.dataset.jid = chat.jid;
    pin.dataset.pinned = chat.pinned ? '1' : '0';
    pin.textContent = chat.pinned ? '★' : '☆';
    pin.classList.toggle('active', Boolean(chat.pinned));
    pin.setAttribute('aria-pressed', String(Boolean(chat.pinned)));
    pin.setAttribute(
      'aria-label',
      chat.pinned ? 'Открепить диалог' : 'Закрепить диалог',
    );
    pin.title = chat.pinned ? 'Открепить диалог' : 'Закрепить диалог';
    renderContactPanel(chat, contactDraft);
  }

  function mergeMessages(first, second) {
    const result = [];
    const indexes = new Map();
    for (const message of [...first, ...second]) {
      const key = message.anchor || `${message.isoTime}\u0000${message.sender}`;
      if (indexes.has(key)) {
        result[indexes.get(key)] = message;
      } else {
        indexes.set(key, result.length);
        result.push(message);
      }
    }
    // Сервер уже отдаёт устойчивый порядок timestamp + message id. Здесь
    // только убираем пересечение соседних страниц, не пересортировывая
    // сообщения с одинаковым временем по непрозрачному anchor.
    return result;
  }

  function sameMessagePage(first, second) {
    if (first.length !== second.length) return false;
    return first.every((message, index) => {
      const other = second[index];
      const mediaIds = (message.media || [])
        .map((item) => item.mediaId)
        .join(',');
      const otherMediaIds = (other?.media || [])
        .map((item) => item.mediaId)
        .join(',');
      return (
        message.anchor === other?.anchor &&
        message.isoTime === other?.isoTime &&
        message.sender === other?.sender &&
        message.text === other?.text &&
        message.kind === other?.kind &&
        message.mediaEnriched === other?.mediaEnriched &&
        mediaIds === otherMediaIds
      );
    });
  }

  function renderHistoryBar() {
    const bar = $('#history-bar');
    const older = $('#chat-load-older');
    const latest = $('#chat-latest');
    const context = $('#history-context');
    older.hidden = !dialogPage.hasMore;
    latest.hidden = !dialogPage.anchored;
    context.textContent = dialogPage.anchored
      ? 'Показан найденный фрагмент истории'
      : '';
    bar.hidden = older.hidden && latest.hidden && !context.textContent;
  }

  async function loadSelectedMessages(options = {}) {
    const chat = allChats.find((item) => item.jid === selectedJid);
    if (!chat) return;
    const target = $('#chat-messages');
    const wasNearBottom =
      target.scrollHeight - target.scrollTop - target.clientHeight < 90;
    const previousTop = target.scrollTop;
    const previousHeight = target.scrollHeight;
    if (options.poll && dialogPage.anchored) return;
    if (
      options.poll &&
      [...target.querySelectorAll('audio, video')].some(
        (player) => !player.paused && !player.ended,
      )
    ) {
      return;
    }
    if (options.older && !dialogPage.nextCursor) return;
    const previousMessages = dialogPage.messages;
    const request = ++dialogRequestSeq;
    const params = new URLSearchParams({ jid: chat.jid, limit: '80' });
    if (options.older) params.set('cursor', dialogPage.nextCursor);
    if (options.anchor) params.set('anchor', options.anchor);
    const olderButton = $('#chat-load-older');
    if (options.older) {
      olderButton.disabled = true;
      olderButton.textContent = 'Загружаю…';
    }
    let data;
    try {
      data = await api(`/api/chat-messages?${params.toString()}`);
    } finally {
      if (options.older) {
        olderButton.disabled = false;
        olderButton.textContent = '↑ Показать более ранние';
      }
    }
    if (request !== dialogRequestSeq || selectedJid !== chat.jid) return;
    const incoming = data.messages || [];
    if (options.older) {
      dialogPage.messages = mergeMessages(incoming, dialogPage.messages);
      dialogPage.hasMore = Boolean(data.hasMore);
      dialogPage.nextCursor = data.nextCursor || null;
      dialogPage.loadedOlder = true;
    } else if (
      options.poll &&
      dialogPage.jid === chat.jid &&
      dialogPage.loadedOlder
    ) {
      dialogPage.messages = mergeMessages(dialogPage.messages, incoming);
    } else {
      dialogPage = {
        jid: chat.jid,
        messages: incoming,
        hasMore: Boolean(data.hasMore),
        nextCursor: data.nextCursor || null,
        anchored: Boolean(data.anchored),
        focusAnchor: options.anchor || null,
        loadedOlder: false,
      };
    }
    if (
      options.poll &&
      sameMessagePage(previousMessages, dialogPage.messages)
    ) {
      renderHistoryBar();
      return;
    }
    target.innerHTML = renderDialogMessages(
      dialogPage.messages,
      chat,
      dialogPage.anchored,
    );
    bindMediaErrors(target);
    renderHistoryBar();
    if (options.older) {
      target.scrollTop = previousTop + (target.scrollHeight - previousHeight);
    } else if (dialogPage.focusAnchor && options.anchor) {
      const focused = [...target.querySelectorAll('.msg')].find(
        (item) => item.dataset.anchor === dialogPage.focusAnchor,
      );
      if (focused) {
        const viewport = target.getBoundingClientRect();
        const messageBox = focused.getBoundingClientRect();
        target.scrollTop = Math.max(
          0,
          target.scrollTop +
            messageBox.top -
            viewport.top -
            (target.clientHeight - messageBox.height) / 2,
        );
      }
      target.dataset.scrolled = '1';
    } else if (
      options.initial ||
      options.latest ||
      wasNearBottom ||
      !target.dataset.scrolled
    ) {
      target.scrollTop = target.scrollHeight;
      target.dataset.scrolled = '1';
    } else {
      target.scrollTop = previousTop;
    }
  }

  async function selectDialog(jid, navigateOnMobile = false, options = {}) {
    const chat = allChats.find((item) => item.jid === jid);
    if (!chat) return;
    const changed = selectedJid !== jid;
    selectedJid = jid;
    if (changed || options.anchor) {
      delete $('#chat-messages').dataset.scrolled;
      dialogPage = emptyDialogPage(jid);
      $('#contact-panel').hidden = true;
      $('#chat-contact').setAttribute('aria-expanded', 'false');
    }
    renderDialogList();
    showDialogHeader(chat);
    if (navigateOnMobile) {
      const shell = $('#dialog-shell');
      shell.classList.add('detail-open');
      if (window.matchMedia('(max-width: 900px)').matches) {
        requestAnimationFrame(() => {
          shell.scrollIntoView({
            block: 'start',
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)')
              .matches
              ? 'auto'
              : 'smooth',
          });
        });
      }
    }
    await loadSelectedMessages({
      initial: changed || Boolean(options.anchor),
      anchor: options.anchor,
    });
  }

  async function renderChats() {
    const [data, whatsappStatus] = await Promise.all([
      api('/api/chats'),
      api('/api/whatsapp-status').catch(() => null),
    ]);
    const contactDraft = captureContactDraft(selectedJid);
    allChats = data.chats || [];
    renderWhatsAppStatus(whatsappStatus);
    renderDialogStats();
    let selected = allChats.find((chat) => chat.jid === selectedJid);
    if (!selected) {
      selected = allChats.find((chat) => chat.canSend) || allChats[0] || null;
      selectedJid = selected?.jid || null;
    }
    renderDialogList();
    if (!selected) {
      $('#dialog-empty').hidden = false;
      $('#dialog-content').hidden = true;
      return;
    }
    showDialogHeader(selected, contactDraft);
    await loadSelectedMessages({
      initial:
        dialogPage.jid !== selected.jid ||
        !$('#chat-messages').dataset.scrolled,
      poll: dialogPage.jid === selected.jid,
    });
  }

  async function sendChat() {
    if (chatSending) return;
    const selected = allChats.find((chat) => chat.jid === selectedJid);
    if (!selected?.canSend || selected.paused) return;
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    chatSending = true;
    $('#chat-send').disabled = true;
    const ok = await action('chat_send', { text });
    chatSending = false;
    $('#chat-send').disabled = false;
    if (ok) {
      input.value = '';
      await renderChats();
    }
  }

  /* ── Модули ── */
  async function renderModules() {
    const data = await api('/api/modules');
    $('#modules').innerHTML = data.modules
      .map(
        (m) => `
      <div class="card">
        <div class="name" style="justify-content:space-between">
          <span>${esc(m.title)}</span>
          ${
            m.kind === 'info'
              ? `<span class="sub">${m.on ? 'настроен' : 'нет'}</span>`
              : `<button class="switch ${m.on ? 'on' : ''}" data-id="${esc(m.id)}" data-on="${m.on ? '1' : ''}" aria-label="${esc(m.title)}"></button>`
          }
        </div>
        <div class="detail">${esc(m.desc)}${m.restartNeeded ? ' · применяется после перезапуска' : ''}</div>
      </div>`,
      )
      .join('');
    $('#modules')
      .querySelectorAll('.switch')
      .forEach((sw) => {
        sw.addEventListener('click', async () => {
          const on = sw.dataset.on === '1';
          const ok = await action('module_toggle', {
            module: sw.dataset.id,
            value: !on,
          });
          if (ok) renderModules();
        });
      });
    $('#restarts').innerHTML = [
      {
        unit: 'main',
        name: 'Перезапустить Скуби',
        warn: '~10 секунд без ответа в Telegram и WhatsApp',
      },
    ]
      .map(
        (r) => `
      <div class="card">
        <div class="name">${esc(r.name)}</div>
        <div class="detail">${esc(r.warn)}</div>
        <button style="margin-top:8px" data-unit="${r.unit}">Перезапустить</button>
      </div>`,
      )
      .join('');
    $('#restarts')
      .querySelectorAll('button[data-unit]')
      .forEach((b) => {
        b.addEventListener('click', () =>
          action(
            'restart_service',
            { unit: b.dataset.unit },
            'Точно перезапустить? ' +
              b.parentElement.querySelector('.detail').textContent,
          ),
        );
      });
  }

  /* ── Google-сервисы ── */
  let googleVerifying = false;
  let googleCooldownTimer = null;
  function googleCards(data) {
    const ws = data.workspace;
    const cal = data.calendar;
    const v = data.verify || {};
    const wsState = ws.configured
      ? '<span class="dot ok"></span>настроен'
      : ws.enabled
        ? `<span class="dot warn"></span>не хватает: ${esc(ws.missing.join(', '))}`
        : '<span class="dot down"></span>выключен';
    const wsVerify = v.workspace
      ? v.workspace.ok
        ? `<div class="detail">✓ OAuth и Drive отвечают: аккаунт <b>${esc(v.workspace.account)}</b>${v.workspace.accountName ? ' (' + esc(v.workspace.accountName) + ')' : ''}. Таблицы и Apps Script здесь не проверяются.</div>`
        : `<div class="detail">⚠ ${esc(v.workspace.error)}</div>`
      : '';
    const calState = cal.configured
      ? '<span class="dot ok"></span>настроен'
      : cal.enabled
        ? `<span class="dot warn"></span>${cal.keyFileFound ? 'нет id календаря' : 'ключ-файл не найден'}`
        : '<span class="dot down"></span>выключен';
    const calVerify = v.calendar
      ? v.calendar.ok
        ? `<div class="detail">✓ Календарь отвечает. Ближайшее: ${
            v.calendar.upcoming.length
              ? v.calendar.upcoming
                  .map((u) => `${esc(u.when)} — ${esc(u.title)}`)
                  .join(' · ')
              : 'событий впереди нет'
          }</div>`
        : `<div class="detail">⚠ ${esc(v.calendar.error)}</div>`
      : '';
    return `
      <div class="card">
        <div class="name" style="justify-content:space-between">
          <span>Workspace: Диск · Таблицы · Скрипты</span><span class="sub">${wsState}</span>
        </div>
        <div class="detail">Ожидаемые OAuth-доступы: ${esc(ws.scopesHuman.join(', ') || 'не заданы')}</div>
        <div class="detail">CRM-таблица: ${
          ws.crm
            ? `<a href="${esc(ws.crm.url)}" target="_blank" rel="noopener">«${esc(ws.crm.title)}»</a>`
            : 'не задана (скажи Скуби в чате, какая таблица рабочая)'
        }</div>
        <div class="detail">Скрипт по умолчанию: ${ws.defaultScriptId ? esc(ws.defaultScriptId) : 'не задан'}</div>
        ${wsVerify}
      </div>
      <div class="card">
        <div class="name" style="justify-content:space-between">
          <span>Календарь</span><span class="sub">${calState}</span>
        </div>
        <div class="detail">Календарь: ${esc(cal.calendarId || '—')}${cal.timezone ? ' · ' + esc(cal.timezone) : ''}</div>
        <div class="detail">Задач с зеркалом в календаре: ${cal.mirroredTasks}</div>
        ${calVerify}
      </div>`;
  }

  async function renderGoogle(verify) {
    const data = await api(
      verify ? '/api/google/verify' : '/api/google',
      verify
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          }
        : undefined,
    );
    $('#google-cards').innerHTML = googleCards(data);
    return data;
  }

  /* ── Задачи ── */
  async function renderTasks() {
    const data = await api('/api/tasks');
    $('#tasks').innerHTML =
      data.tasks
        .map(
          (t) => `
      <div class="row">
        <span class="grow">
          <div>${esc(t.prompt)} ${t.hasCalendar ? '📅' : ''}</div>
          <div class="sub">${esc(t.chatName)} · ${esc(t.schedule)} · ${esc(t.status)} · следующий: ${esc(t.nextRun)}</div>
        </span>
        <span class="actions">
          <button data-act="pause" data-id="${esc(t.id)}" ${t.statusRaw === 'completed' ? 'disabled' : ''}>
            ${t.statusRaw === 'paused' ? '▶' : '⏸'}
          </button>
          <button data-act="run" data-id="${esc(t.id)}" title="запустить сейчас">▶️ сейчас</button>
          <button data-act="del" data-id="${esc(t.id)}" class="danger">🗑</button>
        </span>
      </div>`,
        )
        .join('') ||
      '<div class="row"><span class="grow sub">Задач нет.</span></div>';
    $('#tasks')
      .querySelectorAll('button[data-act]')
      .forEach((b) => {
        b.addEventListener('click', async () => {
          const id = b.dataset.id;
          let ok = null;
          if (b.dataset.act === 'pause') {
            const isPaused = b.textContent.trim() === '▶';
            ok = await action('task_pause', { id, value: !isPaused });
          } else if (b.dataset.act === 'run') {
            ok = await action(
              'task_run_now',
              { id },
              'Запустить задачу прямо сейчас?',
            );
          } else {
            ok = await action(
              'task_delete',
              { id },
              'Удалить задачу насовсем? Отменить будет нельзя.',
            );
          }
          if (ok) renderTasks();
        });
      });
  }

  /* ── Журнал ── */
  async function renderLog() {
    const errors = $('#log-errors').checked ? '1' : '';
    const q = encodeURIComponent($('#log-q').value.trim());
    const data = await api(`/api/log?errors=${errors}&q=${q}`);
    $('#log-lines').innerHTML =
      data.lines
        .map((l) => {
          const cls =
            l.level === 'ERROR' ? 'err' : l.level === 'WARN' ? 'warn' : '';
          return `<span class="${cls}">[${esc(l.time)}] ${esc(l.level)}</span> ${esc(l.text)}`;
        })
        .join('\n') ||
      ($('#log-errors').checked
        ? 'В свежем хвосте лога ошибок нет — уже хорошо. Ошибки за сутки видны в «Обзоре».'
        : 'Журнал пуст.');
  }

  /* ── Табы и поллинг ── */
  const RENDERERS = {
    pult: renderPult,
    chats: renderChats,
    modules: renderModules,
    google: renderGoogle,
    tasks: renderTasks,
    log: renderLog,
  };
  const POLL_MS = { pult: 5000, chats: 10_000, log: 7000 };

  function switchTab(tab) {
    if (!RENDERERS[tab]) return;
    activeTab = tab;
    document.querySelectorAll('nav#tabs button').forEach((b) => {
      const active = b.dataset.tab === tab;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('main > section').forEach((s) => {
      s.hidden = s.id !== `tab-${tab}`;
    });
    timers.forEach(clearInterval);
    timers.length = 0;
    const render = RENDERERS[tab];
    render().catch((e) => toast(e.message, false));
    if (tab !== 'pult') renderPult().catch(() => {});
    history.replaceState(null, '', `#${tab}`);
    if (POLL_MS[tab]) {
      timers.push(
        setInterval(() => {
          if (!document.hidden) render().catch(() => {});
        }, POLL_MS[tab]),
      );
    }
  }

  document
    .querySelectorAll('nav#tabs button')
    .forEach((b) =>
      b.addEventListener('click', () => switchTab(b.dataset.tab)),
    );
  $('#chat-back').addEventListener('click', () => {
    $('#dialog-shell').classList.remove('detail-open');
  });
  $('#chat-send').addEventListener('click', sendChat);
  $('#chat-input').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      sendChat();
    }
  });
  $('#dialog-search').addEventListener('input', queueDialogSearch);
  $('#dialog-filters')
    .querySelectorAll('.filter-chip')
    .forEach((button) => {
      button.addEventListener('click', () => {
        dialogFilter = button.dataset.filter;
        $('#dialog-filters')
          .querySelectorAll('.filter-chip')
          .forEach((item) => {
            const active = item === button;
            item.classList.toggle('active', active);
            item.setAttribute('aria-pressed', String(active));
          });
        renderDialogList();
        if (Array.from($('#dialog-search').value.trim()).length >= 2) {
          clearTimeout(dialogSearchTimer);
          runDialogSearch().catch((err) => toast(err.message, false));
        }
      });
    });
  $('#chat-pause').addEventListener('click', () => {
    const button = $('#chat-pause');
    toggleChatPause(button.dataset.jid, button.dataset.paused === '1').catch(
      (err) => toast(err.message, false),
    );
  });
  $('#chat-pin').addEventListener('click', () => {
    const button = $('#chat-pin');
    toggleDialogPin(button.dataset.jid, button.dataset.pinned === '1').catch(
      (err) => toast(err.message, false),
    );
  });
  $('#chat-contact').addEventListener('click', () => {
    const panel = $('#contact-panel');
    panel.hidden = !panel.hidden;
    $('#chat-contact').setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) $('#contact-alias').focus();
  });
  $('#contact-alias-save').addEventListener('click', async () => {
    const chat = allChats.find((item) => item.jid === selectedJid);
    if (!chat) return;
    const ok = await action('dialog_alias', {
      jid: chat.jid,
      value: $('#contact-alias').value.trim(),
    });
    if (ok) await renderChats();
  });
  $('#contact-alias').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      $('#contact-alias-save').click();
    }
  });
  $('#contact-link-search').addEventListener('input', () => {
    contactLinkTargetJid = null;
    contactPickerActiveIndex = -1;
    $('#contact-link-add').disabled = true;
    const chat = allChats.find((item) => item.jid === selectedJid);
    if (chat) updateContactPicker(chat, true);
  });
  $('#contact-link-search').addEventListener('focus', () => {
    const chat = allChats.find((item) => item.jid === selectedJid);
    if (chat) updateContactPicker(chat, true);
  });
  $('#contact-link-search').addEventListener('blur', () => {
    window.setTimeout(closeContactPicker, 120);
  });
  $('#contact-link-search').addEventListener('keydown', (event) => {
    const chat = allChats.find((item) => item.jid === selectedJid);
    if (!chat) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      if ($('#contact-link-options').hidden) {
        updateContactPicker(chat, true);
      }
      if (contactPickerResults.length) {
        contactPickerActiveIndex =
          contactPickerActiveIndex < 0
            ? direction > 0
              ? 0
              : contactPickerResults.length - 1
            : (contactPickerActiveIndex +
                direction +
                contactPickerResults.length) %
              contactPickerResults.length;
      }
      updateContactPicker(chat, true);
      return;
    }
    if (event.key === 'Enter' && contactPickerActiveIndex >= 0) {
      event.preventDefault();
      selectContactCandidate(contactPickerResults[contactPickerActiveIndex]);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeContactPicker();
    }
  });
  $('#contact-link-add').addEventListener('click', async () => {
    const targetJid = contactLinkTargetJid;
    if (!selectedJid || !targetJid) return;
    const ok = await action('dialog_link', {
      jid: selectedJid,
      targetJid,
      value: true,
    });
    if (ok) {
      contactLinkTargetJid = null;
      $('#contact-link-search').value = '';
      await renderChats();
    }
  });
  $('#chat-load-older').addEventListener('click', () => {
    loadSelectedMessages({ older: true }).catch((err) =>
      toast(err.message, false),
    );
  });
  $('#chat-latest').addEventListener('click', () => {
    dialogPage = emptyDialogPage(selectedJid || '');
    delete $('#chat-messages').dataset.scrolled;
    loadSelectedMessages({ initial: true, latest: true }).catch((err) =>
      toast(err.message, false),
    );
  });
  $('#google-verify').addEventListener('click', async () => {
    if (googleVerifying) return;
    googleVerifying = true;
    const btn = $('#google-verify');
    btn.disabled = true;
    btn.textContent = 'Проверяю…';
    let completed = false;
    try {
      const data = await renderGoogle(true);
      completed = true;
      const checks = [];
      if (data.workspace.enabled) checks.push(data.verify?.workspace);
      if (data.calendar.enabled) checks.push(data.verify?.calendar);
      const failed = checks.filter((result) => !result?.ok).length;
      if (checks.length === 0) {
        toast('Google-сервисы выключены', false);
      } else if (failed > 0) {
        toast('Проверка завершена с ошибками — смотри карточки', false);
      } else {
        toast('Проверка Google выполнена', true);
      }
    } catch (err) {
      toast(err.message, false);
    } finally {
      googleVerifying = false;
      if (completed) {
        clearTimeout(googleCooldownTimer);
        btn.textContent = 'Повторно через 30 секунд';
        googleCooldownTimer = setTimeout(() => {
          btn.disabled = false;
          btn.textContent = 'Проверить подключение';
        }, 30_000);
      } else {
        btn.disabled = false;
        btn.textContent = 'Проверить подключение';
      }
    }
  });
  $('#log-errors').addEventListener('change', renderLog);
  $('#log-q').addEventListener('input', () => {
    clearTimeout(window._logT);
    window._logT = setTimeout(renderLog, 400);
  });

  const requestedTab = location.hash.replace(/^#/, '');
  switchTab(RENDERERS[requestedTab] ? requestedTab : 'pult');
  setInterval(() => {
    if (activeTab !== 'pult' && !document.hidden) renderPult().catch(() => {});
  }, 30_000);
})();
