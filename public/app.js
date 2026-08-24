// ── QuitBuddy App ──────────────────────────────────────────────
(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────
  let currentUser = null;
  let currentChatFriend = null;
  let socket = null;
  let onlineFriends = new Set();

  // ── DOM Refs ──────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const screenLogin = $('#screen-login');
  const screenApp = $('#screen-app');
  const loginUsername = $('#login-username');
  const btnLogin = $('#btn-login');

  // ── PWA Registration ──────────────────────────────────────
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // ── Toast ─────────────────────────────────────────────────
  function toast(msg, type = '') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast ' + type + ' show';
    setTimeout(() => el.className = 'toast', 2500);
  }

  // ── API Helper ────────────────────────────────────────────
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // ── Auth ──────────────────────────────────────────────────
  async function login() {
    const username = loginUsername.value.trim();
    if (!username) return toast('Please enter a username', 'error');
    try {
      let data;
      try {
        data = await api('/api/login', { method: 'POST', body: { username } });
      } catch {
        data = await api('/api/register', { method: 'POST', body: { username, daily_limit: 20 } });
      }
      currentUser = data.user;
      localStorage.setItem('qb_user', JSON.stringify(currentUser));
      showApp();
      toast('Welcome, ' + currentUser.username + '! 🎉', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  btnLogin.addEventListener('click', login);
  loginUsername.addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });

  // ── Show App ──────────────────────────────────────────────
  function showApp() {
    screenLogin.classList.remove('active');
    screenApp.classList.add('active');
    $('#header-username').textContent = currentUser.username;
    connectSocket();
    loadTracker();
    loadFriends();
    loadProfile();
  }

  // ── Check stored session ──────────────────────────────────
  function checkSession() {
    const stored = localStorage.getItem('qb_user');
    if (stored) {
      currentUser = JSON.parse(stored);
      showApp();
    }
  }

  // ── Socket.io ─────────────────────────────────────────────
  function connectSocket() {
    socket = io();
    socket.emit('user-online', currentUser.id);

    socket.on('new-message', (msg) => {
      if (currentChatFriend && msg.sender_id === currentChatFriend.id) {
        appendMessage(msg, false);
        scrollChatToBottom();
      }
      // TODO: update chat list preview
    });

    socket.on('message-sent', (msg) => {
      if (currentChatFriend && msg.receiver_id === currentChatFriend.id) {
        appendMessage(msg, true);
        scrollChatToBottom();
      }
    });

    socket.on('user-status', ({ userId, online }) => {
      if (online) onlineFriends.add(userId);
      else onlineFriends.delete(userId);
      updateFriendStatuses();
    });
  }

  // ── Tabs ──────────────────────────────────────────────────
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('active'));
      $$('.tab-content').forEach((c) => c.classList.remove('active'));
      tab.classList.add('active');
      const id = 'tab-' + tab.dataset.tab;
      $('#' + id).classList.add('active');

      if (tab.dataset.tab === 'friends') loadFriends();
      if (tab.dataset.tab === 'chat') loadChatList();
      if (tab.dataset.tab === 'profile') loadProfile();
      if (tab.dataset.tab === 'tracker') loadTracker();
    });
  });

  // ── Tracker ───────────────────────────────────────────────
  async function loadTracker() {
    try {
      const data = await api(`/api/user/${currentUser.id}`);
      currentUser = data.user;
      updateCounter(data.todayCount, data.user.daily_limit);
      renderWeekChart(data.weekData, data.user.daily_limit);
      renderStats(data.stats);
      loadFriendsProgress();
    } catch (e) {
      console.error(e);
    }
  }

  function updateCounter(count, limit) {
    const counterEl = $('#today-count');
    counterEl.textContent = count;
    counterEl.classList.remove('pulse');
    void counterEl.offsetWidth;
    counterEl.classList.add('pulse');

    $('#display-limit').textContent = limit;

    // Ring progress
    const circumference = 2 * Math.PI * 88;
    const progress = Math.min(count / limit, 1);
    const offset = circumference * (1 - progress);
    const ring = $('#ring-progress');
    ring.style.strokeDashoffset = offset;

    if (count > limit) ring.style.stroke = 'var(--red)';
    else if (count >= limit * 0.8) ring.style.stroke = 'var(--yellow)';
    else ring.style.stroke = 'var(--accent)';

    // Message
    const msgEl = $('#counter-message');
    if (count === 0) msgEl.textContent = 'Perfect day so far! Keep going! 🌟';
    else if (count < limit * 0.5) msgEl.textContent = 'You\'re doing great! Stay strong! 💪';
    else if (count < limit) msgEl.textContent = 'Getting close to your limit. Be mindful! ⚠️';
    else if (count === limit) msgEl.textContent = 'You\'ve hit your daily limit. Stop here! 🛑';
    else msgEl.textContent = 'Over your limit! Time to breathe fresh air! 🌬️';
  }

  function renderWeekChart(weekData, limit) {
    const container = $('#week-chart');
    container.innerHTML = '';
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const today = new Date();

    // Build last 7 days
    const last7 = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const found = weekData.find((w) => w.day === dateStr);
      last7.push({ label: days[d.getDay()], count: found ? found.count : 0, date: dateStr });
    }

    const maxCount = Math.max(limit, ...last7.map((d) => d.count), 1);

    last7.forEach((day) => {
      const col = document.createElement('div');
      col.className = 'chart-day';
      const barH = maxCount > 0 ? (day.count / maxCount) * 100 : 0;
      col.innerHTML = `
        <div class="chart-day-count">${day.count || '-'}</div>
        <div class="chart-bar-wrap">
          <div class="chart-bar ${day.count > limit ? 'over' : ''}" style="height: ${Math.max(barH, 2)}%"></div>
        </div>
        <div class="chart-day-label">${day.label}</div>
      `;
      container.appendChild(col);
    });
  }

  function renderStats(stats) {
    $('#stat-streak').textContent = stats.totalSmokeDays;
    $('#stat-total').textContent = stats.allTime;
    $('#stat-best').textContent = stats.bestDay > 0 ? stats.bestDay : '-';
  }

  // Log / Remove
  $('#btn-log-cig').addEventListener('click', async () => {
    try {
      const data = await api('/api/cig/add', { method: 'POST', body: { user_id: currentUser.id } });
      updateCounter(data.todayCount, data.daily_limit);
      loadWeekChart();
      if (data.todayCount >= data.daily_limit) {
        toast('You\'ve reached your daily limit! 🛑', 'error');
      } else if (data.todayCount === Math.ceil(data.daily_limit * 0.8)) {
        toast('Getting close to your limit! ⚠️', 'error');
      }
    } catch (e) {
      toast('Error logging cigarette', 'error');
    }
  });

  $('#btn-remove-cig').addEventListener('click', async () => {
    try {
      const data = await api('/api/cig/remove', { method: 'POST', body: { user_id: currentUser.id } });
      updateCounter(data.todayCount, data.daily_limit);
      loadWeekChart();
      toast('Cigarette removed ↩️');
    } catch (e) {
      toast('Nothing to remove', 'error');
    }
  });

  async function loadWeekChart() {
    try {
      const data = await api(`/api/user/${currentUser.id}`);
      renderWeekChart(data.weekData, data.user.daily_limit);
    } catch (e) {}
  }

  // ── Friends ───────────────────────────────────────────────
  async function loadFriends() {
    try {
      const friendsData = await api(`/api/friends/${currentUser.id}`);
      renderFriendsList(friendsData.friends);
      $('#my-user-code').textContent = currentUser.id;
    } catch (e) {
      console.error(e);
    }
  }

  function renderFriendsList(friends) {
    const container = $('#friends-list');
    if (!friends.length) {
      container.innerHTML = '<p class="empty-state">No friends yet. Add some to get started!</p>';
      return;
    }
    container.innerHTML = friends.map((f) => `
      <div class="friend-item" data-id="${f.id}" data-name="${f.username}">
        <div class="friend-avatar">${f.username.charAt(0).toUpperCase()}</div>
        <div class="friend-info">
          <div class="friend-name">${f.username}</div>
          <div class="friend-status" id="status-${f.id}">${onlineFriends.has(f.id) ? '🟢 Online' : '⚪ Offline'}</div>
        </div>
        <span class="tab-icon">💬</span>
      </div>
    `).join('');

    container.querySelectorAll('.friend-item').forEach((el) => {
      el.addEventListener('click', () => {
        const friend = { id: el.dataset.id, username: el.dataset.name };
        openChat(friend);
        // Switch to chat tab
        $$('.tab').forEach((t) => t.classList.remove('active'));
        $$('.tab-content').forEach((c) => c.classList.remove('active'));
        $$('.tab')[2].classList.add('active');
        $('#tab-chat').classList.add('active');
      });
    });
  }

  function updateFriendStatuses() {
    document.querySelectorAll('.friend-status').forEach((el) => {
      const id = el.id.replace('status-', '');
      el.textContent = onlineFriends.has(id) ? '🟢 Online' : '⚪ Offline';
    });
  }

  // Add friend by code
  $('#btn-add-friend').addEventListener('click', async () => {
    const friendId = $('#friend-code-input').value.trim();
    if (!friendId) return toast('Paste a friend\'s code', 'error');
    try {
      await api('/api/friends/add', { method: 'POST', body: { user_id: currentUser.id, friend_id: friendId } });
      toast('Friend added! 🎉', 'success');
      $('#friend-code-input').value = '';
      loadFriends();
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  // Copy code
  $('#btn-copy-code').addEventListener('click', () => {
    navigator.clipboard.writeText(currentUser.id).then(() => {
      toast('Code copied! 📋', 'success');
    }).catch(() => {
      toast('Copy failed', 'error');
    });
  });

  // Share code
  $('#btn-share-code').addEventListener('click', () => {
    if (navigator.share) {
      navigator.share({
        title: 'QuitBuddy',
        text: `Add me on QuitBuddy! My code: ${currentUser.id}`,
      }).catch(() => {});
    } else {
      navigator.clipboard.writeText(currentUser.id).then(() => toast('Code copied! 📋', 'success'));
    }
  });

  // Search users
  let searchTimeout;
  $('#search-users-input').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const q = e.target.value.trim();
    if (q.length < 2) {
      $('#search-results').innerHTML = '';
      return;
    }
    searchTimeout = setTimeout(async () => {
      try {
        const data = await api(`/api/search-users?q=${encodeURIComponent(q)}&user_id=${currentUser.id}`);
        renderSearchResults(data.users);
      } catch (e) {}
    }, 300);
  });

  function renderSearchResults(users) {
    const container = $('#search-results');
    if (!users.length) {
      container.innerHTML = '<p class="empty-state">No users found</p>';
      return;
    }
    container.innerHTML = users.map((u) => `
      <div class="search-result">
        <span class="search-result-name">${u.username}</span>
        <button class="btn btn-primary btn-sm btn-add-search" data-id="${u.id}">Add</button>
      </div>
    `).join('');

    container.querySelectorAll('.btn-add-search').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api('/api/friends/add', { method: 'POST', body: { user_id: currentUser.id, friend_id: btn.dataset.id } });
          toast('Friend added! 🎉', 'success');
          btn.textContent = 'Added ✓';
          btn.disabled = true;
          loadFriends();
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    });
  }

  // Friends progress on tracker
  async function loadFriendsProgress() {
    try {
      const data = await api(`/api/friends/${currentUser.id}/progress`);
      const section = $('#friends-progress-section');
      const list = $('#friends-progress-list');
      if (!data.friends.length) {
        section.style.display = 'none';
        return;
      }
      section.style.display = '';
      list.innerHTML = data.friends.map((f) => {
        const pct = f.daily_limit > 0 ? Math.min((f.today_count / f.daily_limit) * 100, 100) : 0;
        const color = f.today_count > f.daily_limit ? 'var(--red)' : f.today_count >= f.daily_limit * 0.8 ? 'var(--yellow)' : 'var(--green)';
        return `
          <div class="friend-progress-item">
            <div class="friend-avatar">${f.username.charAt(0).toUpperCase()}</div>
            <div class="friend-info">
              <div class="friend-name">${f.username}</div>
              <div class="friend-status">${f.today_count} / ${f.daily_limit} today</div>
            </div>
            <div class="friend-progress-bar">
              <div class="friend-progress-fill" style="width:${pct}%;background:${color}"></div>
            </div>
          </div>
        `;
      }).join('');
    } catch (e) {}
  }

  // ── Chat ──────────────────────────────────────────────────
  async function loadChatList() {
    try {
      const data = await api(`/api/friends/${currentUser.id}`);
      const container = $('#chat-list');
      if (!data.friends.length) {
        container.innerHTML = '<p class="empty-state">Add friends to start chatting!</p>';
        return;
      }
      container.innerHTML = data.friends.map((f) => `
        <div class="chat-item" data-id="${f.id}" data-name="${f.username}">
          <div class="chat-avatar">${f.username.charAt(0).toUpperCase()}</div>
          <div class="chat-preview">
            <div class="chat-preview-name">${f.username}</div>
            <div class="chat-preview-text" id="preview-${f.id}">Tap to chat</div>
          </div>
          <div class="chat-time" id="time-${f.id}"></div>
        </div>
      `).join('');

      container.querySelectorAll('.chat-item').forEach((el) => {
        el.addEventListener('click', () => {
          openChat({ id: el.dataset.id, username: el.dataset.name });
        });
      });
    } catch (e) {
      console.error(e);
    }
  }

  async function openChat(friend) {
    currentChatFriend = friend;
    $('#chat-list-view').style.display = 'none';
    $('#chat-room-view').style.display = 'flex';
    $('#chat-partner-name').textContent = friend.username;
    $('#chat-partner-status').textContent = onlineFriends.has(friend.id) ? '🟢 Online' : '⚪ Offline';

    try {
      const data = await api(`/api/messages/${currentUser.id}/${friend.id}`);
      const container = $('#chat-messages');
      container.innerHTML = '';
      data.messages.forEach((m) => {
        appendMessage(m, m.sender_id === currentUser.id);
      });
      scrollChatToBottom();
    } catch (e) {
      console.error(e);
    }

    $('#chat-input').focus();
  }

  function appendMessage(msg, isSent) {
    const container = $('#chat-messages');
    const div = document.createElement('div');
    div.className = 'msg ' + (isSent ? 'msg-sent' : 'msg-received');
    const time = msg.created_at ? new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    div.innerHTML = `
      ${!isSent ? `<div class="msg-sender">${msg.sender_name || ''}</div>` : ''}
      <div>${escapeHtml(msg.content)}</div>
      <div class="msg-time">${time}</div>
    `;
    container.appendChild(div);
  }

  function scrollChatToBottom() {
    const container = $('#chat-messages');
    setTimeout(() => { container.scrollTop = container.scrollHeight; }, 50);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Send message
  $('#btn-send-msg').addEventListener('click', sendMessage);
  $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });

  function sendMessage() {
    const input = $('#chat-input');
    const content = input.value.trim();
    if (!content || !currentChatFriend) return;

    socket.emit('send-message', {
      sender_id: currentUser.id,
      receiver_id: currentChatFriend.id,
      content,
    });
    input.value = '';
    input.focus();
  }

  // Back from chat
  $('#btn-back-chat').addEventListener('click', () => {
    $('#chat-list-view').style.display = '';
    $('#chat-room-view').style.display = 'none';
    currentChatFriend = null;
    loadChatList();
  });

  // ── Profile ───────────────────────────────────────────────
  function loadProfile() {
    if (!currentUser) return;
    $('#profile-username').textContent = currentUser.username;
    $('#profile-id').textContent = currentUser.id;
    $('#limit-display').textContent = currentUser.daily_limit;
    if ($('#stat-total')) $('#profile-total').textContent = currentUser.daily_limit;

    // Load stats
    api(`/api/user/${currentUser.id}`).then((data) => {
      $('#profile-total').textContent = data.stats.allTime;
      $('#profile-days').textContent = data.stats.totalSmokeDays;
      $('#profile-best').textContent = data.stats.bestDay > 0 ? data.stats.bestDay + ' cigs' : 'N/A';
    }).catch(() => {});
  }

  // Change username
  $('#btn-change-username').addEventListener('click', async () => {
    const newUsername = $('#new-username').value.trim();
    if (!newUsername || newUsername.length < 2) return toast('Username must be 2+ characters', 'error');
    try {
      await api(`/api/user/${currentUser.id}/username`, { method: 'PUT', body: { username: newUsername } });
      currentUser.username = newUsername;
      localStorage.setItem('qb_user', JSON.stringify(currentUser));
      $('#header-username').textContent = newUsername;
      loadProfile();
      toast('Username updated! ✅', 'success');
      $('#new-username').value = '';
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  // Daily limit controls
  let currentLimit = 20;

  $('#btn-limit-up').addEventListener('click', () => updateLimit(currentLimit + 1));
  $('#btn-limit-down').addEventListener('click', () => {
    if (currentLimit > 1) updateLimit(currentLimit - 1);
  });

  async function updateLimit(newLimit) {
    try {
      await api(`/api/user/${currentUser.id}/limit`, { method: 'PUT', body: { daily_limit: newLimit } });
      currentLimit = newLimit;
      currentUser.daily_limit = newLimit;
      localStorage.setItem('qb_user', JSON.stringify(currentUser));
      $('#limit-display').textContent = newLimit;
      loadTracker();
      toast(`Daily limit set to ${newLimit} 🎯`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // Logout
  $('#btn-logout').addEventListener('click', () => {
    localStorage.removeItem('qb_user');
    currentUser = null;
    screenApp.classList.remove('active');
    screenLogin.classList.add('active');
    loginUsername.value = '';
    toast('Logged out 👋');
  });

  // ── Init ──────────────────────────────────────────────────
  checkSession();
})();
