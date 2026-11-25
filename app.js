(() => {
  'use strict';

  const DEADLINE_ISO = '2026-12-05T23:59:59+01:00';
  const STORAGE_KEY = 'kth_lades_demo_v1';
  const ME_STORAGE_KEY = 'kth_lades_me_v1';
  const NEW_PLAYER_OPTION = '__new__';

  function createSeedState() {
    const now = Date.now();
    const mins = (m) => new Date(now - m * 60 * 1000).toISOString();

    return {
      players: [
        { id: 'p-kaan', name: 'Kaan' },
        { id: 'p-erik', name: 'Erik' },
        { id: 'p-lukas', name: 'Lukas' },
        { id: 'p-maja', name: 'Maja' },
        { id: 'p-filip', name: 'Filip' },
        { id: 'p-oskar', name: 'Oskar' },
      ],
      events: [
        { id: 'e-1', winnerId: 'p-kaan', loserId: 'p-erik', createdAt: mins(14) },
        { id: 'e-2', winnerId: 'p-maja', loserId: 'p-oskar', createdAt: mins(55) },
        { id: 'e-3', winnerId: 'p-kaan', loserId: 'p-oskar', createdAt: mins(180) },
        { id: 'e-4', winnerId: 'p-lukas', loserId: 'p-filip', createdAt: mins(420) },
        { id: 'e-5', winnerId: 'p-erik', loserId: 'p-filip', createdAt: mins(960) },
      ],
    };
  }

  function makeId(prefix) {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return `${prefix}-${window.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function normalizeName(rawName) {
    return rawName.trim().replace(/\s+/g, ' ');
  }

  // LocalStorage fallback store when Supabase keys are not yet configured
  const LocalStore = {
    isLive: false,

    async getState() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
          const seed = createSeedState();
          localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
          return seed;
        }
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.players) || !Array.isArray(parsed.events)) {
          throw new Error('Invalid state');
        }
        return {
          players: parsed.players,
          events: parsed.events.filter((e) => !e.deletedAt),
        };
      } catch {
        const seed = createSeedState();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
        return seed;
      }
    },

    _readRawState() {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const seed = createSeedState();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
        return seed;
      }
      return JSON.parse(raw);
    },

    _saveState(state) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    },

    async findOrCreatePlayer(rawName) {
      const cleanName = normalizeName(rawName);
      const state = this._readRawState();
      const existing = state.players.find(
        (p) => p.name.toLowerCase() === cleanName.toLowerCase()
      );
      if (existing) {
        return existing;
      }
      const player = { id: makeId('p'), name: cleanName };
      state.players.push(player);
      this._saveState(state);
      return player;
    },

    async logLades(winnerId, loserId) {
      const state = this._readRawState();
      const event = {
        id: makeId('e'),
        winnerId,
        loserId,
        createdAt: new Date().toISOString(),
        deletedAt: null,
      };
      state.events.unshift(event);
      this._saveState(state);
      return event;
    },

    async undoRecentEvent(eventId) {
      const state = this._readRawState();
      const target = state.events.find((e) => e.id === eventId && !e.deletedAt);
      if (!target) {
        throw new Error('Undo window expired. Contact Atahan to edit older scores.');
      }
      target.deletedAt = new Date().toISOString();
      this._saveState(state);
    },

    async resetDemo() {
      const seed = createSeedState();
      this._saveState(seed);
      localStorage.removeItem(ME_STORAGE_KEY);
      return seed;
    },

    subscribe() {
      return null;
    },
  };

  function createSupabaseStore(client) {
    return {
      isLive: true,

      async getState() {
        const [playersRes, eventsRes] = await Promise.all([
          client.from('players').select('id, name').order('name', { ascending: true }),
          client
            .from('lades_events')
            .select('id, winner_id, loser_id, created_at')
            .is('deleted_at', null)
            .order('created_at', { ascending: false }),
        ]);

        if (playersRes.error) {
          throw new Error(`Could not load players: ${playersRes.error.message}`);
        }
        if (eventsRes.error) {
          throw new Error(`Could not load Lades events: ${eventsRes.error.message}`);
        }

        const players = (playersRes.data || []).map((row) => ({
          id: row.id,
          name: row.name,
        }));
        const events = (eventsRes.data || []).map((row) => ({
          id: row.id,
          winnerId: row.winner_id,
          loserId: row.loser_id,
          createdAt: row.created_at,
        }));

        return { players, events };
      },

      async findOrCreatePlayer(rawName, currentPlayers) {
        const cleanName = normalizeName(rawName);
        const pool = Array.isArray(currentPlayers)
          ? currentPlayers
          : (await this.getState()).players;

        const existing = pool.find(
          (p) => p.name.toLowerCase() === cleanName.toLowerCase()
        );
        if (existing) {
          return existing;
        }

        const { data, error } = await client
          .from('players')
          .insert({ name: cleanName })
          .select('id, name')
          .single();

        if (error) {
          // Handle race condition if another teammate created the same name simultaneously
          if (error.code === '23505') {
            const fresh = await this.getState();
            const match = fresh.players.find(
              (p) => p.name.toLowerCase() === cleanName.toLowerCase()
            );
            if (match) return match;
          }
          throw new Error(`Could not add player "${cleanName}": ${error.message}`);
        }

        return { id: data.id, name: data.name };
      },

      async logLades(winnerId, loserId) {
        const { data, error } = await client
          .from('lades_events')
          .insert({ winner_id: winnerId, loser_id: loserId })
          .select('id, winner_id, loser_id, created_at')
          .single();

        if (error) {
          throw new Error(`Could not log Lades: ${error.message}`);
        }

        return {
          id: data.id,
          winnerId: data.winner_id,
          loserId: data.loser_id,
          createdAt: data.created_at,
        };
      },

      async undoRecentEvent(eventId) {
        const { data, error } = await client.rpc('undo_recent_lades', {
          p_event_id: eventId,
        });
        if (error) {
          throw new Error(`Could not undo Lades: ${error.message}`);
        }
        if (!data) {
          throw new Error('Undo window expired. Contact Atahan to edit older scores.');
        }
      },

      subscribe(onChange) {
        const channel = client
          .channel('lades-live')
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'players' },
            () => onChange()
          )
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'lades_events' },
            () => onChange()
          )
          .subscribe();

        return channel;
      },
    };
  }

  function initStore() {
    const cfg = window.LADES_CONFIG || {};
    const url = typeof cfg.SUPABASE_URL === 'string' ? cfg.SUPABASE_URL.trim() : '';
    const key = typeof cfg.SUPABASE_ANON_KEY === 'string' ? cfg.SUPABASE_ANON_KEY.trim() : '';
    const isConfigured =
      Boolean(url) &&
      Boolean(key) &&
      !url.includes('YOUR_SUPABASE_URL') &&
      !key.includes('YOUR_SUPABASE_ANON_KEY') &&
      window.supabase &&
      typeof window.supabase.createClient === 'function';

    if (isConfigured) {
      const client = window.supabase.createClient(url, key);
      return createSupabaseStore(client);
    }
    return LocalStore;
  }

  const Store = initStore();

  function computeScoreboard(players, events) {
    const stats = new Map();
    for (const player of players) {
      stats.set(player.id, {
        id: player.id,
        name: player.name,
        wins: 0,
        losses: 0,
        score: 0,
        inDanger: false,
      });
    }

    for (const ev of events) {
      const winner = stats.get(ev.winnerId);
      const loser = stats.get(ev.loserId);
      if (winner) {
        winner.wins += 1;
        winner.score += 1;
      }
      if (loser) {
        loser.losses += 1;
        loser.score -= 1;
      }
    }

    const rows = Array.from(stats.values()).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.wins !== a.wins) return b.wins - a.wins;
      return a.name.localeCompare(b.name);
    });

    if (rows.length >= 2 && events.length > 0) {
      const minScore = Math.min(...rows.map((r) => r.score));
      for (const row of rows) {
        if (row.score === minScore) {
          row.inDanger = true;
        }
      }
    }

    return rows;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function formatScore(score) {
    if (score > 0) return `+${score}`;
    return String(score);
  }

  function formatRelativeTime(isoString) {
    const diffSec = Math.max(0, Math.floor((Date.now() - new Date(isoString).getTime()) / 1000));
    if (diffSec < 60) return 'just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  }

  // DOM references
  const cdDays = document.getElementById('cd-days');
  const cdHours = document.getElementById('cd-hours');
  const cdMins = document.getElementById('cd-mins');
  const cdSecs = document.getElementById('cd-secs');
  const countdownGrid = document.getElementById('countdown-grid');
  const countdownExpired = document.getElementById('countdown-expired');

  const form = document.getElementById('lades-form');
  const winnerSelect = document.getElementById('winner-select');
  const winnerNewInput = document.getElementById('winner-new-input');
  const winnerNewBtn = document.getElementById('winner-new-btn');
  const loserSelect = document.getElementById('loser-select');
  const loserNewInput = document.getElementById('loser-new-input');
  const loserNewBtn = document.getElementById('loser-new-btn');
  const formError = document.getElementById('form-error');
  const submitBtn = document.getElementById('submit-btn');

  const playerCountEl = document.getElementById('player-count');
  const modeBadge = document.getElementById('mode-badge');
  const scoreboardList = document.getElementById('scoreboard-list');
  const recentList = document.getElementById('recent-list');
  const resetDemoBtn = document.getElementById('reset-demo-btn');

  const toastEl = document.getElementById('toast');
  const toastMessageEl = document.getElementById('toast-message');
  const toastUndoBtn = document.getElementById('toast-undo-btn');

  let toastTimer = null;
  let lastLoggedEventId = null;
  let cachedPlayers = [];
  let isSubmitting = false;
  let realtimeDebounce = null;

  if (Store.isLive) {
    modeBadge.textContent = '● Live';
    modeBadge.classList.add('is-live');
    resetDemoBtn.classList.add('hidden');
  }

  function updateCountdown() {
    const targetMs = new Date(DEADLINE_ISO).getTime();
    const diff = targetMs - Date.now();

    if (diff <= 0) {
      countdownGrid.classList.add('hidden');
      countdownExpired.classList.remove('hidden');
      return;
    }

    countdownGrid.classList.remove('hidden');
    countdownExpired.classList.add('hidden');

    const totalSec = Math.floor(diff / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;

    cdDays.textContent = String(days).padStart(2, '0');
    cdHours.textContent = String(hours).padStart(2, '0');
    cdMins.textContent = String(mins).padStart(2, '0');
    cdSecs.textContent = String(secs).padStart(2, '0');
  }

  function showError(message) {
    formError.textContent = message;
    formError.classList.remove('hidden');
  }

  function clearError() {
    formError.textContent = '';
    formError.classList.add('hidden');
  }

  function syncNewPlayerInput(selectEl, inputEl) {
    const isNew = selectEl.value === NEW_PLAYER_OPTION;
    inputEl.classList.toggle('hidden', !isNew);
    if (!isNew) {
      inputEl.value = '';
    }
  }

  function populateSelect(selectEl, players, placeholder, selectedValue) {
    const sorted = [...players].sort((a, b) => a.name.localeCompare(b.name));
    selectEl.innerHTML = '';

    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = placeholder;
    selectEl.appendChild(defaultOpt);

    for (const player of sorted) {
      const opt = document.createElement('option');
      opt.value = player.id;
      opt.textContent = player.name;
      selectEl.appendChild(opt);
    }

    const newOpt = document.createElement('option');
    newOpt.value = NEW_PLAYER_OPTION;
    newOpt.textContent = '+ Add new player...';
    selectEl.appendChild(newOpt);

    if (
      selectedValue &&
      (selectedValue === NEW_PLAYER_OPTION || players.some((p) => p.id === selectedValue))
    ) {
      selectEl.value = selectedValue;
    } else {
      selectEl.value = '';
    }
  }

  function renderScoreboard(players, events) {
    const rows = computeScoreboard(players, events);
    playerCountEl.textContent = `${rows.length} ${rows.length === 1 ? 'player' : 'players'}`;

    if (rows.length === 0) {
      scoreboardList.innerHTML =
        '<li class="empty-state">No players yet. Log the first Lades above!</li>';
      return;
    }

    scoreboardList.innerHTML = '';
    rows.forEach((row, index) => {
      const li = document.createElement('li');
      const isLeader = index === 0 && row.score > 0 && !row.inDanger;

      li.className = 'score-row';
      if (isLeader) li.classList.add('is-leader');
      if (row.inDanger) li.classList.add('is-danger');

      let rankDisplay = String(index + 1);
      if (isLeader) rankDisplay = '👑';
      else if (row.inDanger) rankDisplay = '🥶';

      let scoreClass = 'zero';
      if (row.score > 0) scoreClass = 'positive';
      else if (row.score < 0) scoreClass = 'negative';

      const dangerBadge = row.inDanger
        ? '<span class="osqvik-pill">❄️ OSQVIK BOUND</span>'
        : '';

      li.innerHTML = `
        <div class="score-left">
          <span class="rank-badge">${rankDisplay}</span>
          <div class="player-meta">
            <div class="player-name-row">
              <span class="player-name">${escapeHtml(row.name)}</span>
              ${dangerBadge}
            </div>
            <span class="player-record">${row.wins}W · ${row.losses}L</span>
          </div>
        </div>
        <span class="score-pill ${scoreClass}">${formatScore(row.score)}</span>
      `;
      scoreboardList.appendChild(li);
    });
  }

  function renderRecent(players, events) {
    const playerMap = new Map(players.map((p) => [p.id, p.name]));
    const sortedEvents = [...events]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 6);

    if (sortedEvents.length === 0) {
      recentList.innerHTML =
        '<li class="empty-state">No Lades logged yet. Stay sharp out there!</li>';
      return;
    }

    recentList.innerHTML = '';
    for (const ev of sortedEvents) {
      const winnerName = playerMap.get(ev.winnerId) || 'Unknown';
      const loserName = playerMap.get(ev.loserId) || 'Unknown';

      const li = document.createElement('li');
      li.className = 'recent-item';
      li.innerHTML = `
        <span class="recent-text">
          <strong>${escapeHtml(winnerName)}</strong> got <strong>${escapeHtml(loserName)}</strong>
          <span class="recent-time">· ${formatRelativeTime(ev.createdAt)}</span>
        </span>
      `;
      recentList.appendChild(li);
    }
  }

  async function renderAll() {
    try {
      const state = await Store.getState();
      cachedPlayers = state.players;

      const savedMe = localStorage.getItem(ME_STORAGE_KEY) || '';
      const currentWinner = winnerSelect.value || savedMe;
      const currentLoser = loserSelect.value;

      populateSelect(winnerSelect, state.players, 'Select your name...', currentWinner);
      populateSelect(loserSelect, state.players, 'Select teammate...', currentLoser);
      syncNewPlayerInput(winnerSelect, winnerNewInput);
      syncNewPlayerInput(loserSelect, loserNewInput);

      renderScoreboard(state.players, state.events);
      renderRecent(state.players, state.events);
    } catch (err) {
      scoreboardList.innerHTML = `<li class="empty-state">${escapeHtml(
        err.message || 'Could not load scoreboard.'
      )}</li>`;
    }
  }

  function showToast(message, eventId) {
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    lastLoggedEventId = eventId;
    toastMessageEl.textContent = message;
    toastUndoBtn.classList.toggle('hidden', !eventId);
    toastEl.classList.remove('hidden');

    toastTimer = setTimeout(() => {
      toastEl.classList.add('hidden');
      lastLoggedEventId = null;
    }, 10000);
  }

  async function resolvePlayerSelection(selectEl, inputEl, roleLabel) {
    const val = selectEl.value;
    if (!val) {
      throw new Error(`Please select ${roleLabel} or add a new player.`);
    }
    if (val === NEW_PLAYER_OPTION) {
      const name = normalizeName(inputEl.value);
      if (!name) {
        inputEl.focus();
        throw new Error(`Please enter a name for ${roleLabel}.`);
      }
      if (name.length > 32) {
        inputEl.focus();
        throw new Error('Player name must be 32 characters or fewer.');
      }
      const created = await Store.findOrCreatePlayer(name, cachedPlayers);
      if (!cachedPlayers.some((p) => p.id === created.id)) {
        cachedPlayers.push(created);
      }
      return created;
    }

    const player = cachedPlayers.find((p) => p.id === val);
    if (!player) {
      throw new Error(`Selected player for ${roleLabel} was not found.`);
    }
    return player;
  }

  // Event listeners
  winnerSelect.addEventListener('change', () => {
    clearError();
    syncNewPlayerInput(winnerSelect, winnerNewInput);
    if (winnerSelect.value === NEW_PLAYER_OPTION) {
      winnerNewInput.focus();
    } else if (winnerSelect.value) {
      localStorage.setItem(ME_STORAGE_KEY, winnerSelect.value);
    }
  });

  loserSelect.addEventListener('change', () => {
    clearError();
    syncNewPlayerInput(loserSelect, loserNewInput);
    if (loserSelect.value === NEW_PLAYER_OPTION) {
      loserNewInput.focus();
    }
  });

  winnerNewBtn.addEventListener('click', () => {
    clearError();
    winnerSelect.value = NEW_PLAYER_OPTION;
    syncNewPlayerInput(winnerSelect, winnerNewInput);
    winnerNewInput.focus();
  });

  loserNewBtn.addEventListener('click', () => {
    clearError();
    loserSelect.value = NEW_PLAYER_OPTION;
    syncNewPlayerInput(loserSelect, loserNewInput);
    loserNewInput.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isSubmitting) return;
    clearError();

    isSubmitting = true;
    const originalBtnText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Logging...';

    try {
      const winner = await resolvePlayerSelection(winnerSelect, winnerNewInput, 'yourself');
      const loser = await resolvePlayerSelection(loserSelect, loserNewInput, 'who you Lades’d');

      if (winner.id === loser.id) {
        throw new Error("You can't Lades yourself! Pick a teammate.");
      }

      const event = await Store.logLades(winner.id, loser.id);
      localStorage.setItem(ME_STORAGE_KEY, winner.id);

      winnerSelect.value = winner.id;
      loserSelect.value = '';
      winnerNewInput.value = '';
      loserNewInput.value = '';
      syncNewPlayerInput(winnerSelect, winnerNewInput);
      syncNewPlayerInput(loserSelect, loserNewInput);

      await renderAll();
      showToast(`${winner.name} Lades'd ${loser.name}! (+1 / -1)`, event.id);
    } catch (err) {
      showError(err.message || 'Could not log Lades.');
    } finally {
      isSubmitting = false;
      submitBtn.disabled = false;
      submitBtn.textContent = originalBtnText;
    }
  });

  toastUndoBtn.addEventListener('click', async () => {
    if (!lastLoggedEventId) return;
    const idToUndo = lastLoggedEventId;
    lastLoggedEventId = null;
    toastEl.classList.add('hidden');
    try {
      await Store.undoRecentEvent(idToUndo);
      await renderAll();
      showToast('Lades entry undone.', null);
    } catch (err) {
      showError(err.message || 'Could not undo Lades entry.');
    }
  });

  resetDemoBtn.addEventListener('click', async () => {
    if (Store.isLive) return;
    await Store.resetDemo();
    winnerSelect.value = '';
    loserSelect.value = '';
    await renderAll();
    showToast('Demo data reset.', null);
  });

  // Init
  updateCountdown();
  setInterval(updateCountdown, 1000);
  if (Store.isLive) {
    scoreboardList.innerHTML = '<li class="empty-state">Loading scoreboard...</li>';
  }
  renderAll();
  Store.subscribe(() => {
    if (realtimeDebounce) clearTimeout(realtimeDebounce);
    realtimeDebounce = setTimeout(() => {
      renderAll();
    }, 150);
  });
})();
