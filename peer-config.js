// WebRTC ICE Configuration for PeerJS (STUN & TURN Servers)
// Memungkinkan koneksi Peer-to-Peer bekerja di jaringan berbeda (LDR / beda WiFi / kuota data seluler).

window.PEER_CONFIG = {
  debug: 1,
  config: {
    iceServers: [
      // STUN servers publik Google & Twilio
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },

      // TURN servers gratis (Open Relay by Metered)
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject@gmail.com',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject@gmail.com',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject@gmail.com',
        credential: 'openrelayproject'
      },
      {
        urls: 'turns:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject@gmail.com',
        credential: 'openrelayproject'
      }
    ]
  }
};

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
