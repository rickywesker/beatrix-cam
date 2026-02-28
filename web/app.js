/* ============================================================
   BEATRIX CAM — Application Logic
   Night vision stream viewer with WebRTC + HLS fallback
   ============================================================ */

(function () {
  'use strict';

  // --- Configuration ---
  const CONFIG = {
    webrtcUrl: `http://${window.location.hostname}:8889/beatrix/`,
    hlsUrl: `http://${window.location.hostname}:8888/beatrix/`,
    hlsCdn: 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.light.min.js',
    reconnectBaseDelay: 2000,
    reconnectMaxDelay: 30000,
    controlsTimeout: 3000,
    clockInterval: 1000,
  };

  // --- DOM refs ---
  const $ = (id) => document.getElementById(id);
  const video = $('video');
  const loadingScreen = $('loading-screen');
  const videoContainer = $('video-container');
  const statusDot = $('status-dot');
  const statusText = $('status-text');
  const timestamp = $('timestamp');
  const streamInfo = $('stream-info');
  const btnFullscreen = $('btn-fullscreen');
  const btnSnapshot = $('btn-snapshot');
  const btnWakelock = $('btn-wakelock');
  const errorOverlay = $('error-overlay');
  const errorTitle = $('error-title');
  const errorMessage = $('error-message');
  const btnRetry = $('btn-retry');

  // --- State ---
  let pc = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let controlsTimer = null;
  let clockTimer = null;
  let wakeLock = null;
  let wakeLockActive = false;
  let currentTransport = '';
  let isConnected = false;
  let hlsInstance = null;

  // ============================================================
  //  STATUS
  // ============================================================

  function setStatus(state, text) {
    statusDot.className = 'status-dot ' + state;
    statusText.textContent = text || state.toUpperCase();
  }

  function showError(title, message) {
    errorTitle.textContent = title;
    errorMessage.textContent = message;
    errorOverlay.hidden = false;
  }

  function hideError() {
    errorOverlay.hidden = true;
  }

  function hideLoading() {
    loadingScreen.classList.add('hidden');
    // Remove from DOM after animation
    setTimeout(() => {
      if (loadingScreen.parentNode) {
        loadingScreen.style.display = 'none';
      }
    }, 900);
  }

  // ============================================================
  //  CLOCK
  // ============================================================

  function updateClock() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    timestamp.textContent = `${h}:${m}:${s}`;
  }

  function startClock() {
    updateClock();
    clockTimer = setInterval(updateClock, CONFIG.clockInterval);
  }

  // ============================================================
  //  CONTROLS AUTO-HIDE
  // ============================================================

  function showControls() {
    videoContainer.classList.remove('controls-hidden');
    resetControlsTimer();
  }

  function hideControls() {
    if (document.fullscreenElement || isConnected) {
      videoContainer.classList.add('controls-hidden');
    }
  }

  function resetControlsTimer() {
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(hideControls, CONFIG.controlsTimeout);
  }

  function initControlsAutoHide() {
    // Mouse
    videoContainer.addEventListener('mousemove', showControls);
    videoContainer.addEventListener('mouseenter', showControls);

    // Touch
    videoContainer.addEventListener('touchstart', showControls, { passive: true });

    // Keyboard
    document.addEventListener('keydown', showControls);

    // Start timer
    resetControlsTimer();
  }

  // ============================================================
  //  WEBRTC (WHEP)
  // ============================================================

  async function connectWebRTC() {
    setStatus('connecting', 'CONNECTING');
    hideError();

    try {
      // Clean up previous connection
      if (pc) {
        pc.close();
        pc = null;
      }

      pc = new RTCPeerConnection({
        iceServers: [],
      });

      // We only receive
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });

      pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          video.srcObject = event.streams[0];
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === 'connected') {
          onStreamConnected('WebRTC');
        } else if (state === 'disconnected' || state === 'failed') {
          onStreamDisconnected();
        }
      };

      // Create offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Wait for ICE gathering
      await waitForIceGathering(pc);

      // Send offer to WHEP endpoint
      const response = await fetch(CONFIG.webrtcUrl + 'whep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: pc.localDescription.sdp,
      });

      if (response.status !== 201) {
        throw new Error(`WHEP returned ${response.status}`);
      }

      const answerSdp = await response.text();
      await pc.setRemoteDescription(new RTCSessionDescription({
        type: 'answer',
        sdp: answerSdp,
      }));
    } catch (err) {
      console.warn('[Beatrix] WebRTC failed:', err.message);
      // Fallback to HLS
      connectHLS();
    }
  }

  function waitForIceGathering(peerConnection) {
    return new Promise((resolve) => {
      if (peerConnection.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      const check = () => {
        if (peerConnection.iceGatheringState === 'complete') {
          peerConnection.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      peerConnection.addEventListener('icegatheringstatechange', check);
      // Safety timeout
      setTimeout(resolve, 3000);
    });
  }

  // ============================================================
  //  HLS FALLBACK
  // ============================================================

  function connectHLS() {
    setStatus('connecting', 'CONNECTING');
    hideError();

    const hlsStreamUrl = CONFIG.hlsUrl + 'index.m3u8';

    // Native HLS (Safari / iOS)
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = hlsStreamUrl;
      video.addEventListener('loadeddata', () => onStreamConnected('HLS'), { once: true });
      video.addEventListener('error', () => onStreamDisconnected(), { once: true });
      video.play().catch(() => {});
      return;
    }

    // hls.js
    if (window.Hls) {
      startHlsJs(hlsStreamUrl);
      return;
    }

    // Load hls.js from CDN
    const script = document.createElement('script');
    script.src = CONFIG.hlsCdn;
    script.onload = () => {
      if (window.Hls && window.Hls.isSupported()) {
        startHlsJs(hlsStreamUrl);
      } else {
        showError('Unsupported Browser', 'Your browser does not support WebRTC or HLS playback.');
        setStatus('error', 'UNSUPPORTED');
      }
    };
    script.onerror = () => {
      showError('Load Error', 'Could not load HLS library. Check your network connection.');
      setStatus('error', 'ERROR');
      scheduleReconnect();
    };
    document.head.appendChild(script);
  }

  function startHlsJs(url) {
    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }

    const hls = new window.Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 30,
    });

    hlsInstance = hls;

    hls.loadSource(url);
    hls.attachMedia(video);

    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
      onStreamConnected('HLS');
    });

    hls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        hls.destroy();
        hlsInstance = null;
        onStreamDisconnected();
      }
    });
  }

  // ============================================================
  //  CONNECTION LIFECYCLE
  // ============================================================

  function onStreamConnected(transport) {
    isConnected = true;
    currentTransport = transport;
    reconnectAttempts = 0;
    clearTimeout(reconnectTimer);

    setStatus('live', 'LIVE');
    hideError();
    hideLoading();

    // Show stream info
    updateStreamInfo();

    // Start auto-hide
    resetControlsTimer();
  }

  function onStreamDisconnected() {
    isConnected = false;
    setStatus('error', 'OFFLINE');
    streamInfo.textContent = '';
    showError('Connection Lost', 'Attempting to reconnect...');
    scheduleReconnect();
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    const delay = Math.min(
      CONFIG.reconnectBaseDelay * Math.pow(1.5, reconnectAttempts),
      CONFIG.reconnectMaxDelay
    );
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
      connect();
    }, delay);
  }

  function connect() {
    // Clean up
    cleanup();
    // Try WebRTC first, falls back to HLS internally
    connectWebRTC();
  }

  function cleanup() {
    if (pc) {
      pc.close();
      pc = null;
    }
    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }
    video.srcObject = null;
    video.removeAttribute('src');
  }

  function updateStreamInfo() {
    const updateInfo = () => {
      if (!isConnected) return;

      const parts = [];
      parts.push(currentTransport);

      if (video.videoWidth && video.videoHeight) {
        parts.push(`${video.videoWidth}x${video.videoHeight}`);
      }

      streamInfo.textContent = parts.join(' \u00b7 ');
    };

    // Update now and when video dimensions change
    updateInfo();
    video.addEventListener('resize', updateInfo);
  }

  // ============================================================
  //  FULLSCREEN
  // ============================================================

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      const el = videoContainer;
      (el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen).call(el);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen).call(document);
    }
  }

  // ============================================================
  //  SNAPSHOT
  // ============================================================

  function takeSnapshot() {
    if (!video.videoWidth) return;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);

    const a = document.createElement('a');
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `beatrix-${ts}.jpg`;
    a.href = canvas.toDataURL('image/jpeg', 0.92);
    a.click();
  }

  // ============================================================
  //  WAKE LOCK
  // ============================================================

  async function toggleWakeLock() {
    if (!('wakeLock' in navigator)) return;

    if (wakeLockActive && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
      wakeLockActive = false;
      btnWakelock.classList.remove('active');
      return;
    }

    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLockActive = true;
      btnWakelock.classList.add('active');

      wakeLock.addEventListener('release', () => {
        wakeLockActive = false;
        btnWakelock.classList.remove('active');
      });
    } catch (err) {
      console.warn('[Beatrix] Wake Lock failed:', err.message);
    }
  }

  // Re-acquire wake lock on visibility change
  async function reacquireWakeLock() {
    if (wakeLockActive && !wakeLock && 'wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLockActive = false;
          btnWakelock.classList.remove('active');
        });
      } catch (_) {
        // Ignore
      }
    }
  }

  // ============================================================
  //  VISIBILITY CHANGE
  // ============================================================

  function handleVisibilityChange() {
    if (document.hidden) {
      // Tab is hidden — pause reconnect attempts
      clearTimeout(reconnectTimer);
    } else {
      // Tab is visible again
      reacquireWakeLock();

      if (!isConnected) {
        // Reconnect immediately
        reconnectAttempts = 0;
        connect();
      }
    }
  }

  // ============================================================
  //  KEYBOARD SHORTCUTS
  // ============================================================

  function handleKeydown(e) {
    switch (e.key) {
      case 'f':
      case 'F':
        e.preventDefault();
        toggleFullscreen();
        break;
      case 's':
      case 'S':
        e.preventDefault();
        takeSnapshot();
        break;
      case 'w':
      case 'W':
        e.preventDefault();
        toggleWakeLock();
        break;
      case 'Escape':
        // Browser handles fullscreen exit
        break;
    }
  }

  // ============================================================
  //  DOUBLE-TAP FULLSCREEN (mobile)
  // ============================================================

  let lastTap = 0;
  function handleDoubleTap(e) {
    const now = Date.now();
    if (now - lastTap < 300) {
      e.preventDefault();
      toggleFullscreen();
    }
    lastTap = now;
  }

  // ============================================================
  //  INITIALIZATION
  // ============================================================

  function init() {
    // Start clock
    startClock();

    // Button listeners
    btnFullscreen.addEventListener('click', toggleFullscreen);
    btnSnapshot.addEventListener('click', takeSnapshot);
    btnWakelock.addEventListener('click', toggleWakeLock);
    btnRetry.addEventListener('click', () => {
      reconnectAttempts = 0;
      connect();
    });

    // Hide wake lock button if not supported
    if (!('wakeLock' in navigator)) {
      btnWakelock.style.display = 'none';
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', handleKeydown);

    // Double-tap for fullscreen on mobile
    videoContainer.addEventListener('touchend', handleDoubleTap);

    // Visibility change
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Controls auto-hide
    initControlsAutoHide();

    // Start connection
    connect();
  }

  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
