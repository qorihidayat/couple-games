// WebRTC ICE Configuration for PeerJS (STUN & TURN Servers)
// Konfigurasi ini memungkinkan koneksi Peer-to-Peer bekerja di jaringan berbeda
// (beda WiFi, kuota internet seluler seperti Telkomsel/XL/Indosat/Tri, atau LDR).

window.PEER_CONFIG = {
  debug: 1,
  config: {
    iceServers: [
      // STUN servers publik Google & Twilio untuk mendeteksi IP publik
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },

      // TURN servers gratis (Open Relay by Metered)
      // Bertindak sebagai jembatan/relay jika koneksi langsung terhalang Symmetric NAT / Firewall provider seluler
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

