// WebRTC ICE Configuration for PeerJS (STUN & TURN Servers)
// Memungkinkan koneksi Peer-to-Peer bekerja di jaringan berbeda (LDR / beda WiFi / kuota data seluler).

// PENGATURAN TURN SERVER RESMI (GRATIS DARI METERED.CA)
window.METERED_CONFIG = {
  domain: 'akacracked.metered.live',
  apiKey: 'dacd6cea4c901f101d93b19197326b0e6861'
};

// === ICE CONFIG ===
// Default: hanya STUN (cepat untuk koneksi langsung / WiFi ke WiFi)
// TURN akan ditambahkan secara async oleh initMeteredTurn() di bawah
// iceTransportPolicy: 'all' berarti browser coba direct dulu, baru relay
window.PEER_CONFIG = {
  debug: 1,
  pingInterval: 5000, // Menjaga WebSocket tetap hidup di jaringan seluler/mobile
  config: {
    iceTransportPolicy: 'all', // 'all' = coba P2P langsung dulu, relay hanya jika perlu
    iceServers: [
      // STUN Google — untuk koneksi langsung (WiFi-WiFi), sangat cepat
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  }
};

// Cache kredensial TURN di localStorage agar tidak perlu fetch ulang tiap buka halaman
// Kredensial Metered biasanya valid 24 jam
(async function initMeteredTurn() {
  const cfg = window.METERED_CONFIG;
  if (!cfg || !cfg.apiKey) return;

  const CACHE_KEY = 'metered_ice_cache';
  const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 jam dalam ms

  // Coba ambil dari cache dulu (sangat cepat, tidak perlu network)
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (cached && cached.ts && (Date.now() - cached.ts < CACHE_TTL) && cached.ice && cached.ice.length) {
      window.PEER_CONFIG.config.iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        ...cached.ice
      ];
      console.log('[CoupleNet] TURN dari cache lokal (' + cached.ice.length + ' servers). Tidak perlu fetch API.');
      return;
    }
  } catch (_) {}

  // Fetch fresh dari API Metered (hanya jika cache kosong / kadaluarsa)
  const rawHost = (cfg.domain || cfg.appName || 'akacracked').trim();
  const host = rawHost.endsWith('.metered.live') ? rawHost : rawHost + '.metered.live';
  const url = 'https://' + host + '/api/v1/turn/credentials?apiKey=' + cfg.apiKey;

  try {
    const res = await fetch(url);
    if (res.ok) {
      const ice = await res.json();
      if (Array.isArray(ice) && ice.length) {
        window.PEER_CONFIG.config.iceServers = [
          { urls: 'stun:stun.l.google.com:19302' },
          ...ice
        ];
        // Simpan ke cache
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), ice: ice }));
        } catch (_) {}
        console.log('[CoupleNet] TURN Metered diperbarui dari API:', ice.length, 'servers.');
      }
    }
  } catch (err) {
    // Fallback: tetap gunakan STUN saja jika gagal fetch (koneksi WiFi-WiFi tetap jalan)
    console.warn('[CoupleNet] Gagal fetch TURN API, hanya pakai STUN:', err.message);
  }
})();

function getPeerConfig(overrides) {
  if (!overrides) return window.PEER_CONFIG;
  return Object.assign({}, window.PEER_CONFIG, overrides);
}

function getPeerConfig(overrides) {
  if (!overrides) return window.PEER_CONFIG;
  return Object.assign({}, window.PEER_CONFIG, overrides);
}

// ============================================================================
// CoupleNet: Auto-Reconnect, Heartbeat Ping/Pong & Game State Synchronization
// ============================================================================
(function() {
  // Inject floating notification banner CSS
  const style = document.createElement('style');
  style.textContent = `
    .couplenet-banner {
      position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
      z-index: 99999; padding: 12px 18px; border-radius: 12px;
      font-size: 0.88rem; font-weight: 600; display: flex; align-items: center;
      gap: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.5);
      animation: couplenetSlideDown 0.3s ease-out; max-width: 90vw;
      font-family: 'Segoe UI', system-ui, sans-serif;
    }
    .couplenet-banner.warn {
      background: #2b1f0e; border: 1px solid #f59e0b; color: #fde68a;
    }
    .couplenet-banner.ok {
      background: #0f2d1e; border: 1px solid #22c55e; color: #86efac;
    }
    .couplenet-banner.resume {
      background: #1c152e; border: 1px solid #c44dff; color: #f0eef5;
    }
    .couplenet-btn {
      background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.25);
      color: inherit; padding: 4px 10px; border-radius: 6px; cursor: pointer;
      font-size: 0.8rem; font-weight: 700; white-space: nowrap;
    }
    .couplenet-btn:hover { background: rgba(255,255,255,0.25); }
    @keyframes couplenetSlideDown {
      from { opacity: 0; transform: translate(-50%, -15px); }
      to { opacity: 1; transform: translate(-50%, 0); }
    }
  `;
  document.head.appendChild(style);

  window.CoupleNet = {
    // Session storage helpers
    saveSession(gameKey, data) {
      try {
        sessionStorage.setItem('couple_session_' + gameKey, JSON.stringify(data));
      } catch (e) {}
    },
    getSession(gameKey) {
      try {
        const raw = sessionStorage.getItem('couple_session_' + gameKey);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    },
    clearSession(gameKey) {
      try {
        sessionStorage.removeItem('couple_session_' + gameKey);
      } catch (e) {}
    },

    // Resilient Guest Join with automatic re-attempts (handles mobile Host switching apps/tab)
    joinRoom(options) {
      const { peer, roomCode, setupConn, setStatus, onConnected } = options;
      setStatus(`Menghubungkan ke room ${roomCode}...`, 'info');

      let attempts = 0;
      let activeConn = null;
      let isConnected = false;
      let timer = null;

      function tryConnect() {
        if (!peer || peer.destroyed || isConnected) return;
        attempts++;

        if (activeConn) {
          try { activeConn.close(); } catch (e) {}
        }

        activeConn = peer.connect(roomCode, { reliable: true });

        activeConn.on('open', () => {
          isConnected = true;
          if (timer) clearInterval(timer);
          if (typeof onConnected === 'function') onConnected(activeConn);
        });

        setupConn(activeConn);

        if (attempts > 1) {
          setStatus(`Menghubungkan ke room ${roomCode}... (Mencoba ${attempts}x. Pastikan layar HP Host menyala & tidak diminimize)`, 'info');
        }
      }

      tryConnect();

      // Retry every 8s if still connecting (e.g. Host was copying code to WhatsApp and just returned to browser)
      timer = setInterval(() => {
        if (!peer || peer.destroyed || isConnected) {
          clearInterval(timer);
          return;
        }
        if (attempts < 6) {
          tryConnect();
        } else {
          clearInterval(timer);
          setStatus(`Belum tersambung ke room ${roomCode}. Pastikan kode benar dan web di HP Host sedang dibuka.`, 'warn');
        }
      }, 8000);
    },

    // Check if previous session exists on page load and ask to resume
    checkResume(gameKey, onResume, onDiscard) {
      const sess = this.getSession(gameKey);
      if (sess && sess.roomCode) {
        const el = document.createElement('div');
        el.className = 'couplenet-banner resume';
        el.id = 'couplenetResumeBanner';
        el.innerHTML = `
          <span>Kamu sebelumnya di Room <strong>${sess.roomCode}</strong>. Lanjutkan?</span>
          <button class="couplenet-btn" id="btnResumeYes">Lanjutkan</button>
          <button class="couplenet-btn" id="btnResumeNo" style="opacity:0.75;">Batal</button>
        `;
        document.body.appendChild(el);

        document.getElementById('btnResumeYes').onclick = () => {
          el.remove();
          if (typeof onResume === 'function') onResume(sess);
        };
        document.getElementById('btnResumeNo').onclick = () => {
          el.remove();
          this.clearSession(gameKey);
          if (typeof onDiscard === 'function') onDiscard();
        };
      }
    },

    // Attach full resilience to a game
    // options: {
    //   gameKey: string,
    //   getState: () => state,
    //   onSetupConn: (conn) => void,
    //   onSyncSend: () => object (state snapshot to send to partner),
    //   onSyncReceive: (snapshot) => void (apply received snapshot to game state & UI)
    // }
    bind(options) {
      const { gameKey, getState, onSetupConn, onSyncSend, onSyncReceive } = options;

      let bannerEl = null;
      let reconnectTimer = null;
      let heartbeatTimer = null;
      let lastPongTime = Date.now();
      let reconnectAttempts = 0;
      let isReconnecting = false;

      function showBanner(type, text, showRetryBtn = false) {
        if (!bannerEl) {
          bannerEl = document.createElement('div');
          bannerEl.id = 'couplenetStatusBanner';
          document.body.appendChild(bannerEl);
        }
        bannerEl.className = 'couplenet-banner ' + type;
        bannerEl.innerHTML = `
          <span>${text}</span>
          ${showRetryBtn ? '<button class="couplenet-btn" id="couplenetRetryBtn">Sambung Sekarang</button>' : ''}
        `;
        if (showRetryBtn) {
          const btn = document.getElementById('couplenetRetryBtn');
          if (btn) btn.onclick = () => triggerReconnect(true);
        }
      }

      function hideBanner() {
        if (bannerEl) {
          bannerEl.remove();
          bannerEl = null;
        }
      }

      // Heartbeat Ping / Pong
      function startHeartbeat() {
        stopHeartbeat();
        lastPongTime = Date.now();
        heartbeatTimer = setInterval(() => {
          const state = getState();
          if (!state.connected || !state.conn) return;

          // Check if partner hasn't replied to ping for > 9 seconds
          if (Date.now() - lastPongTime > 9000) {
            console.warn('[CoupleNet] Heartbeat timeout! Connection dead.');
            triggerDisconnect();
            return;
          }

          try {
            state.conn.send({ type: '__ping__', t: Date.now() });
          } catch (e) {
            triggerDisconnect();
          }
        }, 3000);
      }

      function stopHeartbeat() {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      }

      // Handle disconnection
      function triggerDisconnect() {
        const state = getState();
        state.connected = false;
        stopHeartbeat();

        const badge = document.getElementById('connBadge');
        if (badge) {
          badge.textContent = '○ Terputus';
          badge.style.color = '#ff6b6b';
        }

        startAutoReconnect();
      }

      // Auto-Reconnect Loop
      function startAutoReconnect() {
        if (isReconnecting) return;
        isReconnecting = true;
        reconnectAttempts = 0;

        attemptReconnect();
        reconnectTimer = setInterval(attemptReconnect, 3500);
      }

      function stopAutoReconnect() {
        isReconnecting = false;
        if (reconnectTimer) {
          clearInterval(reconnectTimer);
          reconnectTimer = null;
        }
      }

      function attemptReconnect() {
        const state = getState();
        if (state.connected) {
          stopAutoReconnect();
          hideBanner();
          return;
        }

        reconnectAttempts++;
        const sess = CoupleNet.getSession(gameKey) || {};
        const roomCode = sess.roomCode || state.roomCode || state.roomId;

        if (!roomCode) {
          showBanner('warn', 'Koneksi terputus. Kode room tidak ditemukan.', false);
          return;
        }

        showBanner('warn', `Sinyal/data terputus. Menyambung kembali ke room ${roomCode}... (${reconnectAttempts})`, true);

        // 1. Ensure Peer signaling connection is active
        if (state.peer) {
          if (state.peer.disconnected && !state.peer.destroyed) {
            console.log('[CoupleNet] Reconnecting Peer signaling server...');
            try { state.peer.reconnect(); } catch (e) {}
          }
        }

        // 2. If Guest, re-dial to Host's roomCode
        if (!state.isHost) {
          console.log(`[CoupleNet] Guest redialing room ${roomCode}...`);
          try {
            if (!state.peer || state.peer.destroyed) {
              const pConfig = typeof getPeerConfig === 'function' ? getPeerConfig() : (window.PEER_CONFIG || { debug: 1 });
              state.peer = new Peer(pConfig);
              bindPeerEvents(state.peer);
            }
            if (state.peer && !state.peer.disconnected) {
              const newConn = state.peer.connect(roomCode, { reliable: true });
              if (typeof onSetupConn === 'function') onSetupConn(newConn);
            }
          } catch (e) {
            console.warn('[CoupleNet] Reconnect error:', e);
          }
        } else {
          // If Host, ensure Peer is listening on roomCode
          if (!state.peer || state.peer.destroyed) {
            try {
              const pConfig = typeof getPeerConfig === 'function' ? getPeerConfig() : (window.PEER_CONFIG || { debug: 1 });
              state.peer = new Peer(roomCode, pConfig);
              bindPeerEvents(state.peer);
            } catch (e) {}
          }
        }
      }

      function triggerReconnect(forceNow = false) {
        if (forceNow) {
          attemptReconnect();
        }
      }

      function bindPeerEvents(peer) {
        if (!peer) return;
        peer.on('disconnected', () => {
          console.warn('[CoupleNet] Peer disconnected from signaling server.');
          try { peer.reconnect(); } catch (e) {}
        });
        peer.on('connection', conn => {
          console.log('[CoupleNet] Incoming connection received!');
          if (typeof onSetupConn === 'function') onSetupConn(conn);
        });
      }

      // Network online/offline event listeners
      window.addEventListener('online', () => {
        console.log('[CoupleNet] Network is back online!');
        showBanner('warn', 'Internet terhubung kembali. Mencoba menyambung ke room...', false);
        const state = getState();
        if (state.peer && state.peer.disconnected) {
          try { state.peer.reconnect(); } catch (e) {}
        }
        setTimeout(() => triggerReconnect(true), 1000);
      });

      window.addEventListener('offline', () => {
        console.log('[CoupleNet] Network went offline.');
        triggerDisconnect();
      });

      // Crucial for Mobile / HP: Reconnect signaling when browser tab becomes active again
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          console.log('[CoupleNet] Tab visible again, verifying Peer connection...');
          const state = getState();
          if (state.peer && state.peer.disconnected && !state.peer.destroyed) {
            console.log('[CoupleNet] Reconnecting Peer signaling server...');
            try { state.peer.reconnect(); } catch (e) {}
          }
          if (!state.connected && (state.roomCode || state.roomId)) {
            triggerReconnect(true);
          }
        }
      });

      // Keep signaling connection alive on mobile networks every 15s
      setInterval(() => {
        const state = getState();
        if (state.peer && state.peer.disconnected && !state.peer.destroyed) {
          try { state.peer.reconnect(); } catch (e) {}
        }
      }, 15000);

      // Hook called when a connection opens successfully
      function handleConnectionOpen(conn) {
        stopAutoReconnect();
        stopHeartbeat();
        const state = getState();
        state.connected = true;
        state.conn = conn;

        // Save session
        const roomCode = state.roomCode || state.roomId;
        if (roomCode) {
          CoupleNet.saveSession(gameKey, {
            roomCode: roomCode,
            isHost: state.isHost,
            myName: state.myName,
            partnerName: state.partnerName
          });
        }

        // Show success banner temporarily
        showBanner('ok', 'Terhubung kembali! 🟢', false);
        setTimeout(hideBanner, 2000);

        startHeartbeat();

        // Sync game state
        if (state.isHost) {
          // Host sends full state snapshot
          if (typeof onSyncSend === 'function') {
            const snapshot = onSyncSend();
            if (snapshot) {
              setTimeout(() => {
                try { conn.send({ type: '__sync_state__', snapshot }); } catch (e) {}
              }, 400);
            }
          }
        } else {
          // Guest requests state sync from Host
          setTimeout(() => {
            try { conn.send({ type: '__request_sync__' }); } catch (e) {}
          }, 400);
        }
      }

      // Packet filter: intercepts internal CoupleNet packets (__ping__, __pong__, __sync_state__, __request_sync__)
      function filterData(data, rawConn) {
        if (!data) return false;

        if (data.type === '__ping__') {
          lastPongTime = Date.now();
          try { rawConn.send({ type: '__pong__' }); } catch (e) {}
          return true; // handled
        }
        if (data.type === '__pong__') {
          lastPongTime = Date.now();
          return true; // handled
        }
        if (data.type === '__request_sync__') {
          console.log('[CoupleNet] Partner requested state sync.');
          if (typeof onSyncSend === 'function') {
            const snapshot = onSyncSend();
            if (snapshot) {
              try { rawConn.send({ type: '__sync_state__', snapshot }); } catch (e) {}
            }
          }
          return true; // handled
        }
        if (data.type === '__sync_state__') {
          console.log('[CoupleNet] Received state sync from partner:', data.snapshot);
          if (typeof onSyncReceive === 'function') {
            onSyncReceive(data.snapshot);
          }
          return true; // handled
        }

        // Any regular game packet also updates lastPongTime
        lastPongTime = Date.now();
        return false; // let game code process it
      }

      return {
        handleConnectionOpen,
        triggerDisconnect,
        filterData,
        bindPeerEvents,
        saveSession: (data) => CoupleNet.saveSession(gameKey, data),
        clearSession: () => CoupleNet.clearSession(gameKey)
      };
    }
  };
})();
