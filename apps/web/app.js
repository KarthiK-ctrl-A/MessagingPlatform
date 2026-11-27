(() => {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const state = { config: null, session: null, role: null, contacts: [], conversations: [], selected: null, messages: [], olderCursor: null, refreshPromise: null, loadingMessages: null, pendingMessageId: null };
  const storageKey = 'careline.session';
  let toastTimer;

  function showToast(message) {
    const toast = byId('toast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 5000);
  }

  function showLoginError(message) {
    const error = byId('loginError');
    error.textContent = message;
    error.hidden = !message;
  }

  function saveSession(data) {
    state.session = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      userId: data.user?.id || state.session?.userId,
      email: data.user?.email || state.session?.email || '',
    };
    sessionStorage.setItem(storageKey, JSON.stringify(state.session));
  }

  function showChat() {
    byId('authView').hidden = true;
    byId('chatView').hidden = false;
    const email = state.session?.email || 'Your account';
    byId('accountName').textContent = email;
    byId('accountAvatar').textContent = email[0].toUpperCase();
  }

  function signOut(message) {
    state.session = null;
    state.role = null;
    state.contacts = [];
    state.selected = null;
    state.conversations = [];
    state.messages = [];
    sessionStorage.removeItem(storageKey);
    byId('chatView').hidden = true;
    byId('authView').hidden = false;
    byId('password').value = '';
    if (message) showLoginError(message);
  }

  async function authRequest(grantType, credentials) {
    const response = await fetch(`${state.config.supabaseUrl.replace(/\/$/, '')}/auth/v1/token?grant_type=${grantType}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: state.config.publishableKey },
      body: JSON.stringify(credentials),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error_description || data.msg || data.message || 'Sign in failed');
    if (!data.access_token || !data.refresh_token) throw new Error('Authentication response was incomplete');
    saveSession(data);
    return data;
  }

  async function refreshSession() {
    if (!state.session?.refreshToken) throw new Error('Please sign in again');
    if (!state.refreshPromise) {
      state.refreshPromise = authRequest('refresh_token', { refresh_token: state.session.refreshToken })
        .finally(() => { state.refreshPromise = null; });
    }
    return state.refreshPromise;
  }

  async function accessToken(forceRefresh = false) {
    if (!state.session) throw new Error('Please sign in');
    if (forceRefresh || state.session.expiresAt < Date.now() / 1000 + 30) {
      try { await refreshSession(); }
      catch { signOut('Your session expired. Please sign in again.'); throw new Error('Your session expired'); }
    }
    return state.session.accessToken;
  }

  async function api(path, options = {}, retry = true) {
    const token = await accessToken();
    const response = await fetch(`/v1${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    if (response.status === 401 && retry) {
      await accessToken(true);
      return api(path, options, false);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || `Request failed (${response.status})`);
    return data;
  }

  function dateLabel(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
  }

  function timeLabel(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  }

  function conversationTitle(item) {
    const peerId = item.userLow === state.session?.userId ? item.userHigh : item.userLow;
    return state.contacts.find((contact) => contact.userId === peerId)?.fullName || `Conversation ${item.id.slice(0, 8)}`;
  }

  function renderContacts() {
    const picker = byId('contactPicker');
    picker.replaceChildren();
    const title = document.createElement('span');
    title.className = 'contact-picker-title';
    title.textContent = 'ASSIGNED PATIENTS';
    picker.append(title);
    if (!state.contacts.length) {
      const empty = document.createElement('p');
      empty.className = 'contact-picker-empty';
      empty.textContent = 'No patients are currently assigned to you.';
      picker.append(empty);
    }
    for (const contact of state.contacts) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'contact-option';
      button.textContent = contact.fullName;
      button.addEventListener('click', () => { void openConversation('/conversations', { otherUserId: contact.userId }); });
      picker.append(button);
    }
  }

  async function loadContacts() {
    const result = await api('/conversations/care-contacts');
    state.role = result.role;
    state.contacts = result.contacts;
    const doctor = state.role === 'doctor';
    byId('openActionLabel').textContent = doctor ? 'Message a patient' : 'Message my doctor';
    byId('openDoctorButton').setAttribute('aria-label', doctor ? 'Message a patient' : 'Message my doctor');
    byId('openDoctorButton').disabled = state.role !== 'doctor' && state.role !== 'patient';
    byId('emptyDescription').textContent = doctor
      ? 'Choose a conversation, or start one with an assigned patient.'
      : 'Choose a conversation, or start one with your currently assigned doctor.';
    byId('contactPicker').hidden = true;
    renderContacts();
    renderConversations();
  }

  function renderConversations() {
    const list = byId('conversationList');
    list.replaceChildren();
    if (!state.conversations.length) {
      const empty = document.createElement('p');
      empty.className = 'list-empty';
      empty.textContent = state.role === 'doctor'
        ? 'No conversations yet. Choose “Message a patient” to start one.'
        : 'No conversations yet. Choose “Message my doctor” to start one.';
      list.append(empty);
      return;
    }
    for (const item of state.conversations) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `conversation-item${state.selected?.id === item.id ? ' active' : ''}`;
      button.setAttribute('role', 'listitem');
      button.setAttribute('aria-label', conversationTitle(item));
      button.addEventListener('click', () => { void selectConversation(item); });
      const avatar = document.createElement('span');
      avatar.className = 'conversation-avatar';
      avatar.textContent = '✳';
      const copy = document.createElement('span');
      copy.className = 'conversation-copy';
      const title = document.createElement('strong');
      title.textContent = conversationTitle(item);
      const description = document.createElement('span');
      description.textContent = 'Private conversation';
      copy.append(title, description);
      const date = document.createElement('span');
      date.className = 'conversation-time';
      date.textContent = dateLabel(item.createdAt);
      button.append(avatar, copy, date);
      list.append(button);
    }
  }

  async function loadConversations() {
    state.conversations = await api('/conversations?limit=50');
    renderConversations();
  }

  async function loadPortal() {
    await loadContacts();
    await loadConversations();
  }

  async function openConversation(path, body) {
    const button = byId('openDoctorButton');
    button.disabled = true;
    byId('contactPicker').hidden = true;
    try {
      const item = await api(path, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) });
      await loadConversations();
      await selectConversation(item);
    } catch (error) { showToast(error.message); }
    finally { button.disabled = false; }
  }

  function renderMessages(scrollToEnd = false) {
    const list = byId('messageList');
    list.replaceChildren();
    for (const item of state.messages) {
      const row = document.createElement('div');
      row.className = `message-row${item.senderId === state.session?.userId ? ' own' : ''}`;
      const bubble = document.createElement('div');
      bubble.className = 'message-bubble';
      bubble.textContent = item.content;
      const meta = document.createElement('time');
      meta.className = 'message-meta';
      meta.dateTime = item.createdAt;
      meta.textContent = timeLabel(item.createdAt);
      row.append(bubble, meta);
      list.append(row);
    }
    if (!state.messages.length) {
      const empty = document.createElement('p');
      empty.className = 'list-empty';
      empty.textContent = 'No messages yet. Say hello below.';
      list.append(empty);
    }
    byId('olderButton').hidden = !state.olderCursor;
    if (scrollToEnd) byId('threadBody').scrollTop = byId('threadBody').scrollHeight;
  }

  async function loadMessages(mode) {
    if (!state.selected) return;
    const id = state.selected.id;
    const busy = state.loadingMessages?.id === id ? state.loadingMessages.mode : null;
    // A background poll never blocks a user action; only polls are skipped while busy.
    if (busy && (mode === 'poll' || busy !== 'poll')) return;
    const token = { id, mode };
    const oldHeight = byId('threadBody').scrollHeight;
    const oldTop = byId('threadBody').scrollTop;
    const nearBottom = oldHeight - oldTop - byId('threadBody').clientHeight < 120;
    state.loadingMessages = token;
    try {
      const before = mode === 'older' && state.olderCursor ? `&before=${encodeURIComponent(state.olderCursor)}` : '';
      const page = await api(`/conversations/${encodeURIComponent(id)}/messages?limit=50${before}`);
      if (state.selected?.id !== id) return;
      if (mode === 'initial') state.messages = [];
      const merged = new Map(state.messages.map((item) => [item.id, item]));
      for (const item of page.items) merged.set(item.id, item);
      state.messages = [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      if (mode !== 'poll') state.olderCursor = page.nextCursor;
      renderMessages(mode === 'initial' || (mode === 'poll' && nearBottom));
      if (mode === 'older') byId('threadBody').scrollTop = byId('threadBody').scrollHeight - oldHeight + oldTop;
    } catch (error) { if (mode !== 'poll') showToast(error.message); }
    finally { if (state.loadingMessages === token) state.loadingMessages = null; }
  }

  async function selectConversation(item) {
    state.selected = item;
    state.messages = [];
    state.olderCursor = null;
    renderConversations();
    byId('threadTitle').textContent = conversationTitle(item);
    byId('threadSubtitle').textContent = 'Private care conversation';
    byId('emptyState').hidden = true;
    byId('messageArea').hidden = false;
    byId('messageForm').hidden = false;
    byId('composerHint').hidden = false;
    renderMessages();
    await loadMessages('initial');
  }

  byId('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    showLoginError('');
    byId('loginButton').disabled = true;
    let signedIn = false;
    try {
      await authRequest('password', { email: byId('email').value.trim(), password: byId('password').value });
      byId('password').value = '';
      showChat();
      signedIn = true;
      await loadPortal();
    } catch (error) { if (signedIn) showToast(error.message); else showLoginError(error.message); }
    finally { byId('loginButton').disabled = false; }
  });

  byId('openDoctorButton').addEventListener('click', () => {
    if (state.role === 'doctor') {
      byId('contactPicker').hidden = !byId('contactPicker').hidden;
      byId('openDoctorButton').setAttribute('aria-expanded', String(!byId('contactPicker').hidden));
    } else if (state.role === 'patient') {
      void openConversation('/conversations/current-doctor');
    }
  });

  byId('messageForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const content = byId('messageInput').value.trim();
    if (!content || !state.selected) return;
    const button = byId('sendButton');
    button.disabled = true;
    state.pendingMessageId ||= crypto.randomUUID();
    try {
      const item = await api(`/conversations/${encodeURIComponent(state.selected.id)}/messages`, {
        method: 'POST', body: JSON.stringify({ clientMessageId: state.pendingMessageId, content }),
      });
      const merged = new Map(state.messages.map((message) => [message.id, message]));
      merged.set(item.id, item);
      state.messages = [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      state.pendingMessageId = null;
      byId('messageInput').value = '';
      renderMessages(true);
    } catch (error) { showToast(error.message); }
    finally { button.disabled = false; }
  });

  byId('messageInput').addEventListener('input', () => { state.pendingMessageId = null; });
  byId('messageInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); byId('messageForm').requestSubmit(); }
  });
  byId('olderButton').addEventListener('click', () => { void loadMessages('older'); });
  byId('refreshButton').addEventListener('click', () => { void loadPortal().catch((error) => showToast(error.message)); });
  byId('signOutButton').addEventListener('click', () => {
    const token = state.session?.accessToken;
    const config = state.config;
    signOut();
    if (token && config) {
      void fetch(`${config.supabaseUrl.replace(/\/$/, '')}/auth/v1/logout?scope=local`, {
        method: 'POST', headers: { apikey: config.publishableKey, Authorization: `Bearer ${token}` },
      }).catch(() => { /* Local sign-out has already cleared this tab. */ });
    }
  });
  setInterval(() => { if (state.session && state.selected && document.visibilityState === 'visible') void loadMessages('poll'); }, 5000);

  async function initialize() {
    try {
      const response = await fetch('/v1/public-config', { cache: 'no-store' });
      if (!response.ok) throw new Error('Unable to load web configuration');
      state.config = await response.json();
      if (!state.config.supabaseUrl || state.config.supabaseUrl.includes('YOUR_PROJECT') ||
          !state.config.publishableKey || state.config.publishableKey.includes('REPLACE_ME')) {
        throw new Error('Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in .env, then restart the gateway.');
      }
      const stored = sessionStorage.getItem(storageKey);
      if (stored) {
        try {
          state.session = JSON.parse(stored);
          if (!state.session?.accessToken || !state.session?.refreshToken || !state.session?.userId) throw new Error('Invalid session');
          await accessToken();
          showChat();
        } catch { signOut(); return; }
        try { await loadPortal(); }
        catch (error) { showToast(error.message); }
      }
    } catch (error) { showLoginError(error.message); byId('loginButton').disabled = true; }
  }
  void initialize();
})();
