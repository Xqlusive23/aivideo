import React, { useState, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import { createDecartClient, models } from "@decartai/sdk";
import AccessGate from "./AccessGate.jsx";
import { LogoLockup } from "./Logo.jsx";
import { WHATSAPP_NUMBER, WHATSAPP_DEFAULT_MESSAGE } from "./siteConfig.js";
import { theme } from "./theme.js";
import {
  LEDGER_URL,
  checkAccessToken,
  normalizeAccessToken,
} from "./ledgerClient.js";

const { colors: c, gradients: g, fonts: f, radius: r, shadow: s } = theme;
const fd = f.display;

function formatStatusDisplay(raw) {
  const exact = {
    "SYSTEM STANDBY": "Ready",
    "DEVICE READY // AWAITING DISPATCH": "Camera ready",
    "PAYLOAD READY FOR TRANSMISSION": "Reference loaded",
    "PROVISIONING MEDIA INPUTS...": "Starting camera…",
    "HANDSHAKING WITH DECART WEBRTC CLUSTER...": "Connecting…",
    "COMPUTE LINK ONLINE // REALTIME TRANSFORMATION TERMINAL": "Live",
    "PIPELINE DISCONNECTED": "Stopped",
    "PIPELINE TERMINATED": "Stopped",
    "INSTALLING DRIVERS — APPROVE UAC": "Installing drivers…",
    "CHECKOUT CANCELLED": "Checkout cancelled",
    "REDIRECTING TO CHECKOUT...": "Opening checkout…",
  };
  if (exact[raw]) return exact[raw];
  if (raw.startsWith("OUT OF CREDITS")) return "Out of credits";
  if (raw.startsWith("HARDWARE ERROR")) return raw.replace(/^HARDWARE ERROR:\s*/i, "Camera error · ");
  if (raw.startsWith("DRIVER SETUP FAILED")) return "Driver setup failed";
  if (raw.startsWith("PAYMENT")) return raw.toLowerCase().replace(/^\w/, (ch) => ch.toUpperCase());
  if (raw === raw.toUpperCase() && /[A-Z]/.test(raw)) {
    return raw
      .toLowerCase()
      .replace(/\s*\/\/\s*/g, " · ")
      .replace(/\s*—\s*/g, " · ")
      .replace(/^\w/, (ch) => ch.toUpperCase());
  }
  return raw;
}

// From project root .env — VITE_DECART_API_KEY=your_key_here (never commit .env or hardcode keys here).
const MY_DECART_KEY = (import.meta.env?.VITE_DECART_API_KEY || "").trim();

// How long a live transformation session is allowed to run before auto-stopping.
// This is just a UX cap, unrelated to billing.
// (Previously a hardcoded 5-minute session cap lived here — removed. Lucy
// 2.5 is explicitly designed for indefinite runtime, so sessions now only
// end when the user stops them or credits run out — see stopTransformation
// and the heartbeat's `depleted` handling.)

// --- Real credit ledger backend --------------------------------------------
// See /ledger-backend. The browser NEVER decides the balance — it only ever
// displays whatever this server last reported.
const NAIRA_PER_DOLLAR = 2000; // must match ledger-backend/server.js — keep these in sync
const CREDITS_PER_DOLLAR = 100; // must also match ledger-backend/server.js's TIERS
const NAIRA_PER_CREDIT = NAIRA_PER_DOLLAR / CREDITS_PER_DOLLAR; // = ₦20 per credit
const DISPLAY_CREDITS_PER_SECOND = 2; // for UI copy only — the server decides the real rate
const LOW_CREDIT_THRESHOLD = 40; // ~20 seconds left at 2 credits/sec — warn before it runs out
const HEARTBEAT_INTERVAL_MS = 1000; // 1s ticks → ~2 credits deducted per tick at 2 credits/sec

const TOP_UP_OPTIONS = [
  { naira: 20000, credits: 1000 },
  { naira: 100000, credits: 5000 },
  { naira: 200000, credits: 10000, popular: true },
  { naira: 1000000, credits: 50000 },
];

// --- WhatsApp contact (shown on the access-token gate) ---------------------
// Configured in src/siteConfig.js

// --- Voice changer -----------------------------------------------------------
// Converts your actual mic audio into a different voice (same words, same
// timing) via ElevenLabs Speech-to-Speech, proxied through the ledger backend
// so the API key never reaches the browser. Works in rolling chunks, not
// sample-by-sample — there's always at least one chunk's worth of delay,
// since ElevenLabs' Voice Changer converts complete clips, not a continuous
// stream. Shorter chunks = snappier turnaround but slightly choppier/lower-
// context conversion; longer chunks = smoother conversion but more delay.
const VOICE_CHUNK_MS = 500;
const MOBILE_LAYOUT_MAX_WIDTH = 900;

// Real-time voice conversion server (voice-rt-server on RunPod) — a
// continuous WebSocket alternative to the ElevenLabs chunk-based pipeline
// above. See /voice-rt-server/README.md for what this actually is and why
// it's architecturally different (no per-chunk delay).
const VOICE_RT_URL = import.meta.env?.VITE_VOICE_RT_URL || "";
const VOICE_RT_FRAME_SAMPLES_DEFAULT = 6400; // 400ms @ 16kHz — must match voice-rt-server FRAME_MS (synced from /voices)

export default function App() {
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("SYSTEM STANDBY");
  const [selectedFile, setSelectedFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);

  const [bitrate, setBitrate] = useState("Adaptive (4.2 Mbps)");
  const [latency, setLatency] = useState("0 ms");
  const [fps, setFps] = useState(0);

  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const [inferenceWeight, setInferenceWeight] = useState(85);
  const [enhanceMask, setEnhanceMask] = useState(true);
  const [activeModel, setActiveModel] = useState("lucy-realtime-v2.5");

  // --- Voice changer state ---
  const [voiceChangerEnabled, setVoiceChangerEnabled] = useState(false);
  const [voices, setVoices] = useState([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState("");
  const [voiceLoadError, setVoiceLoadError] = useState("");
  const [voicesLoading, setVoicesLoading] = useState(true);

  // 'elevenlabs' = chunk-based (working today, has inherent per-chunk delay).
  // 'realtime' = continuous WebSocket via voice-rt-server (requires that
  // separate service to actually be deployed — see /voice-rt-server).
  const [voiceEngine, setVoiceEngine] = useState("elevenlabs");
  const [rtcVoices, setRtcVoices] = useState([]);
  const [rtcSelectedVoiceId, setRtcSelectedVoiceId] = useState("");
  const [rtcLoadError, setRtcLoadError] = useState("");
  const [rtcVoicesLoading, setRtcVoicesLoading] = useState(true);
  const [rtcFrameSamples, setRtcFrameSamples] = useState(VOICE_RT_FRAME_SAMPLES_DEFAULT);
  const [voicePreviewLoading, setVoicePreviewLoading] = useState(false);
  const [voicePreviewError, setVoicePreviewError] = useState("");

  const [videoDevices, setVideoDevices] = useState([]);
  const [selectedVideoDeviceId, setSelectedVideoDeviceId] = useState("");
  const [audioDevices, setAudioDevices] = useState([]);
  const [selectedAudioDeviceId, setSelectedAudioDeviceId] = useState("");
  const [routeAudioToVirtualCable, setRouteAudioToVirtualCable] = useState(() => {
    try {
      return window.localStorage.getItem("inspiretech_route_virtual_audio") === "1";
    } catch {
      return false;
    }
  });
  const [cameraActive, setCameraActive] = useState(false);
  const selectedVideoDeviceIdRef = useRef("");
  const selectedVideoDeviceLabelRef = useRef("");
  const selectedAudioDeviceIdRef = useRef("");

  const MODEL_ID_MAP = {
    "lucy-realtime-v2.5": "lucy-2.5", // current flagship — released after this app was first built
    "lucy-realtime-v2.1": "lucy-2.1",
    "lucy-speed-v1.9": "lucy-1.9",
  };
  const getModelId = () => MODEL_ID_MAP[activeModel] || "lucy-2.5";

  // --- Access token (given to you by the admin — see ledger-backend README) ---
  const [accessToken, setAccessToken] = useState(() => {
    try {
      return window.localStorage.getItem("inspiretech_access_token") || "";
    } catch {
      return "";
    }
  });
  const [sessionReady, setSessionReady] = useState(() => {
    try {
      return !window.localStorage.getItem("inspiretech_access_token");
    } catch {
      return true;
    }
  });
  const accessCheckPausedRef = useRef(false);
  const gateJustAuthenticatedRef = useRef(false);
  const [tokenError, setTokenError] = useState("");
  const [gateLoading, setGateLoading] = useState(false);
  const [gateSetupMessage, setGateSetupMessage] = useState("");
  const [driverSetupFailed, setDriverSetupFailed] = useState(false);
  const [driverSetupBusy, setDriverSetupBusy] = useState(false);

  const isCompanionApp = () =>
    typeof window !== "undefined" && Boolean(window.inspiretechCompanion?.isDesktop);

  const getClientId = () => {
    const storageKey = "inspiretech_client_id";
    try {
      let clientId = window.localStorage.getItem(storageKey);
      if (!clientId) {
        clientId = crypto.randomUUID();
        window.localStorage.setItem(storageKey, clientId);
      }
      return clientId;
    } catch {
      return "anonymous";
    }
  };

  const getClientPlatform = () => {
    if (isCompanionApp()) return "windows-app";
    const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";
    if (/iPhone|iPad|iPod|Android|Mobile/i.test(ua)) return "mobile";
    if (typeof window !== "undefined" && window.matchMedia(`(max-width: ${MOBILE_LAYOUT_MAX_WIDTH}px)`).matches) {
      return "mobile";
    }
    return "desktop-web";
  };

  const authHeaders = (tokenOverride) => {
    const token = normalizeAccessToken(tokenOverride ?? accessToken);
    return {
      "X-Access-Token": token,
      "X-Client-Platform": getClientPlatform(),
    };
  };

  const saveAccessToken = (token) => {
    setAccessToken(token);
    try {
      window.localStorage.setItem("inspiretech_access_token", token);
    } catch {
      // localStorage unavailable — token just won't persist across reloads
    }
  };

  const clearAccessToken = () => {
    setAccessToken("");
    try {
      window.localStorage.removeItem("inspiretech_access_token");
    } catch {
      // ignore
    }
  };

  // --- Real credit balance state (sourced from the ledger backend) ---
  const [credits, setCredits] = useState(0);
  const [creditsLoaded, setCreditsLoaded] = useState(false);
  const [ledgerUnreachable, setLedgerUnreachable] = useState(false);
  const [sessionCreditsUsed, setSessionCreditsUsed] = useState(0);
  const [showAddCredits, setShowAddCredits] = useState(false);
  const [isPoppedOut, setIsPoppedOut] = useState(false);
  const [mobileOutputFocus, setMobileOutputFocus] = useState(false);
  const [theaterControlsVisible, setTheaterControlsVisible] = useState(true);
  const [mobileControlsOpen, setMobileControlsOpen] = useState(true);
  const [isMobileLayout, setIsMobileLayout] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia(`(max-width: ${MOBILE_LAYOUT_MAX_WIDTH}px)`).matches
      : false
  );
  const pipSupported = typeof document !== "undefined" && document.pictureInPictureEnabled;

  const localVideoRef = useRef(null);
  const outputVideoRef = useRef(null);
  const companionCanvasRef = useRef(null);
  const companionCaptureIntervalRef = useRef(null);
  const companionAudioRef = useRef(null);
  const desktopCaptureFrameRef = useRef(null); // requestAnimationFrame id, only used inside the Electron shell
  const fileInputRef = useRef(null);
  const localStreamRef = useRef(null);
  const realtimeClientRef = useRef(null);
  const fpsIntervalRef = useRef(null);
  const clockTimerRef = useRef(null); // the local 5-min UX countdown (not billing)
  const heartbeatTimerRef = useRef(null); // the real billing tick, talking to the server
  const billingSessionIdRef = useRef(null);
  const theaterControlsTimerRef = useRef(null);
  const creditSectionRef = useRef(null);
  const startInProgressRef = useRef(false);

  // --- Voice changer refs ---
  const voiceChangerActiveRef = useRef(false);
  const voiceRecorderRef = useRef(null);
  const audioContextRef = useRef(null);
  const voiceDestinationRef = useRef(null);
  const voiceSessionRef = useRef(null);
  const analyserRef = useRef(null);
  const voiceLevelIntervalRef = useRef(null);
  const chunkHadSpeechRef = useRef(false);
  const speechSamplesInChunkRef = useRef(0);
  const chunkSampleChecksRef = useRef(0);
  const noiseFloorRef = useRef(0.005); // adaptive ambient-noise estimate, updated continuously while quiet
  const rtcSocketRef = useRef(null);
  const rtcWorkletNodeRef = useRef(null);
  const rtcMicSourceRef = useRef(null);
  const voiceRtUrlRef = useRef(VOICE_RT_URL); // synced from ledger; fallback to build-time VITE_VOICE_RT_URL
  const voicePreviewAudioRef = useRef(null);
  const voicePreviewObjectUrlRef = useRef(null);

  const buildVideoConstraints = (deviceId, { strictDevice = false, relaxed = false } = {}) => {
    const constraints = {
      frameRate: { ideal: 24 },
      width: { ideal: relaxed ? 1280 : 1920 },
      height: { ideal: relaxed ? 720 : 1080 },
    };
    if (deviceId) {
      constraints.deviceId = strictDevice ? { exact: deviceId } : { ideal: deviceId };
    }
    return constraints;
  };

  const buildAudioConstraints = (deviceId) => {
    const base = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (deviceId) {
      return { ...base, deviceId: { ideal: deviceId } };
    }
    return base;
  };

  const refreshMediaDevices = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const previousVideoId = selectedVideoDeviceIdRef.current;
      const previousVideoLabel = selectedVideoDeviceLabelRef.current;
      const previousAudioId = selectedAudioDeviceIdRef.current;
      const previousAudioLabel = audioDevices.find((d) => d.deviceId === previousAudioId)?.label || "";

      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter((device) => device.kind === "videoinput");
      const audioInputs = devices.filter((device) => device.kind === "audioinput");
      setVideoDevices(videoInputs);
      setAudioDevices(audioInputs);

      if (previousVideoLabel) {
        const remappedVideo = videoInputs.find(
          (device) => device.label && device.label === previousVideoLabel
        );
        if (remappedVideo && remappedVideo.deviceId !== previousVideoId) {
          selectedVideoDeviceIdRef.current = remappedVideo.deviceId;
          setSelectedVideoDeviceId(remappedVideo.deviceId);
        }
      }

      if (previousAudioLabel) {
        const remappedAudio = audioInputs.find(
          (device) => device.label && device.label === previousAudioLabel
        );
        if (remappedAudio && remappedAudio.deviceId !== previousAudioId) {
          selectedAudioDeviceIdRef.current = remappedAudio.deviceId;
          setSelectedAudioDeviceId(remappedAudio.deviceId);
        }
      }
    } catch (err) {
      console.warn("Could not enumerate media devices:", err);
    }
  };

  const refreshVideoDevices = refreshMediaDevices;

  const openCameraStream = async (deviceId) => {
    const audio = buildAudioConstraints(selectedAudioDeviceIdRef.current);
    if (!deviceId) {
      return navigator.mediaDevices.getUserMedia({
        audio,
        video: buildVideoConstraints(""),
      });
    }

    try {
      return await navigator.mediaDevices.getUserMedia({
        audio,
        video: buildVideoConstraints(deviceId, { strictDevice: true }),
      });
    } catch (err) {
      if (err?.name !== "OverconstrainedError" && err?.name !== "NotFoundError") {
        throw err;
      }
      // Same device, looser resolution — still keep deviceId exact so we don't fall back to DroidCam.
      return navigator.mediaDevices.getUserMedia({
        audio,
        video: buildVideoConstraints(deviceId, { strictDevice: true, relaxed: true }),
      });
    }
  };

  useEffect(() => {
    refreshMediaDevices();
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return undefined;
    mediaDevices.addEventListener("devicechange", refreshMediaDevices);
    return () => mediaDevices.removeEventListener("devicechange", refreshMediaDevices);
  }, []);

  const stopLocalVideoStream = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    setCameraActive(false);
  };

  // --- Fetch the real balance on load, and handle returning from Paystack Checkout ---
  useEffect(() => {
    if (!accessToken || !sessionReady) return;
    refreshBalance();

    const params = new URLSearchParams(window.location.search);
    const checkoutResult = params.get("checkout");
    const reference = params.get("reference") || params.get("trxref"); // Paystack appends one or both of these

    if (checkoutResult || reference) {
      window.history.replaceState({}, "", window.location.pathname);

      if (checkoutResult === "success" && reference) {
        setStatus("PAYMENT RECEIVED — VERIFYING...");
        verifyPurchase(reference);
      } else if (checkoutResult === "cancel") {
        setStatus("CHECKOUT CANCELLED");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, sessionReady]);

  // Validate a saved token once before entering the studio (avoids 401 poll spam).
  useEffect(() => {
    if (!accessToken) {
      setSessionReady(true);
      return undefined;
    }
    if (gateJustAuthenticatedRef.current) {
      gateJustAuthenticatedRef.current = false;
      return undefined;
    }

    let cancelled = false;
    setSessionReady(false);
    accessCheckPausedRef.current = false;

    (async () => {
      const validation = await validateAccessToken(accessToken);
      if (cancelled) return;
      if (!validation.ok) {
        handleTokenRejected(validation.error);
        return;
      }
      setCredits(validation.credits);
      setCreditsLoaded(true);
      setLedgerUnreachable(false);
      setSessionReady(true);
      await reportPresence(accessToken);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  // Desktop app: if the user already has a saved token but drivers were never
  // installed (e.g. migrated from web), install them on load.
  useEffect(() => {
    if (!accessToken || !sessionReady || !isCompanionApp()) return;
    let cancelled = false;

    (async () => {
      try {
        await runCompanionDriverSetup({ forceReinstall: false, fromGate: false });
        if (!cancelled) {
          setDriverSetupFailed(false);
          setStatus("SYSTEM STANDBY");
        }
      } catch (err) {
        if (!cancelled) {
          setDriverSetupFailed(true);
          setStatus(`DRIVER SETUP FAILED: ${err.message}`);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [accessToken, sessionReady]);

  // Idle access check: catches admin revoke/delete while the user is on the page.
  useEffect(() => {
    if (!accessToken || !sessionReady) return undefined;

    const TOKEN_POLL_MS = 2000;
    const checkAccess = () => {
      refreshBalance();
    };

    checkAccess();
    const interval = setInterval(checkAccess, TOKEN_POLL_MS);

    const onVisible = () => {
      if (document.visibilityState === "visible") checkAccess();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", checkAccess);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", checkAccess);
    };
  }, [accessToken, sessionReady]);

  // --- Electron desktop shell integration (no-op in the normal web app) ---
  // window.inspireTechDesktop only exists when this page is running inside
  // inspiretech-desktop's Electron wrapper (see preload.js there). In a
  // regular browser tab this whole effect does nothing — the check at the
  // top bails out immediately, so this can't affect normal web usage.
  useEffect(() => {
    if (!window.inspireTechDesktop?.isElectron) return;

    const TARGET_FPS = 24;
    const frameIntervalMs = 1000 / TARGET_FPS;
    let lastFrameTime = 0;
    let canvas = null;
    let ctx = null;

    const drawFrame = (now) => {
      if (!outputVideoRef.current || !ctx) return;
      if (now - lastFrameTime >= frameIntervalMs) {
        lastFrameTime = now;
        ctx.drawImage(outputVideoRef.current, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        window.inspireTechDesktop.sendFrame(imageData.data.buffer);
      }
      desktopCaptureFrameRef.current = requestAnimationFrame(drawFrame);
    };

    const startCapture = async () => {
      const video = outputVideoRef.current;
      if (!video) return;
      const width = video.videoWidth || 1280;
      const height = video.videoHeight || 720;

      await window.inspireTechDesktop.startVirtualCam(width, height, TARGET_FPS);

      canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      ctx = canvas.getContext("2d", { willReadFrequently: true });

      desktopCaptureFrameRef.current = requestAnimationFrame(drawFrame);
    };

    const stopCapture = () => {
      if (desktopCaptureFrameRef.current) {
        cancelAnimationFrame(desktopCaptureFrameRef.current);
        desktopCaptureFrameRef.current = null;
      }
      window.inspireTechDesktop.stopVirtualCam();
    };

    if (isRunning) {
      startCapture();
    } else {
      stopCapture();
    }

    return () => stopCapture();
  }, [isRunning]);

  // Keep the button label in sync if the user closes the PiP window
  // directly (its own native close control) rather than clicking our button.
  useEffect(() => {
    const video = outputVideoRef.current;
    if (!video) return;
    const onEnter = () => setIsPoppedOut(true);
    const onLeave = () => setIsPoppedOut(false);
    video.addEventListener("enterpictureinpicture", onEnter);
    video.addEventListener("leavepictureinpicture", onLeave);
    return () => {
      video.removeEventListener("enterpictureinpicture", onEnter);
      video.removeEventListener("leavepictureinpicture", onLeave);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const mediaQuery = window.matchMedia(`(max-width: ${MOBILE_LAYOUT_MAX_WIDTH}px)`);
    const syncLayout = (event) => {
      setIsMobileLayout(event.matches);
      if (!event.matches) setMobileControlsOpen(true);
    };
    syncLayout(mediaQuery);
    mediaQuery.addEventListener("change", syncLayout);
    return () => mediaQuery.removeEventListener("change", syncLayout);
  }, []);

  useEffect(() => {
    if (isMobileLayout && isRunning) {
      setMobileControlsOpen(false);
    } else if (isMobileLayout && !isRunning) {
      setMobileControlsOpen(true);
    }
  }, [isMobileLayout, isRunning]);

  const THEATER_CONTROLS_HIDE_MS = 3500;

  const clearTheaterControlsTimer = () => {
    if (theaterControlsTimerRef.current) {
      clearTimeout(theaterControlsTimerRef.current);
      theaterControlsTimerRef.current = null;
    }
  };

  const scheduleTheaterControlsHide = () => {
    clearTheaterControlsTimer();
    theaterControlsTimerRef.current = setTimeout(() => {
      setTheaterControlsVisible(false);
    }, THEATER_CONTROLS_HIDE_MS);
  };

  const revealTheaterControls = () => {
    setTheaterControlsVisible(true);
    scheduleTheaterControlsHide();
  };

  const enterMobileTheater = () => {
    if (!isRunning) {
      setStatus("START TRANSFORMATION FIRST — THEN TAP FULL SCREEN");
      return;
    }
    const video = outputVideoRef.current;
    if (!video?.srcObject) {
      setStatus("WAITING FOR VIDEO — TRY AGAIN IN A MOMENT");
      return;
    }
    setMobileOutputFocus(true);
    setTheaterControlsVisible(true);
    scheduleTheaterControlsHide();
    try {
      document.documentElement.style.overflow = "hidden";
      document.body.style.overflow = "hidden";
    } catch {
      // ignore
    }
  };

  const exitMobileTheater = async () => {
    setMobileOutputFocus(false);
    setIsPoppedOut(false);
    clearTheaterControlsTimer();
    setTheaterControlsVisible(true);
    try {
      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      if (document.fullscreenElement) await document.exitFullscreen();
      if (outputVideoRef.current?.webkitDisplayingFullscreen) {
        outputVideoRef.current.webkitExitFullscreen?.();
      }
    } catch {
      // ignore
    }
  };

  // Desktop PiP / mobile theater exit handler.
  const handlePopOutVideo = async () => {
    try {
      if (isMobileLayout) {
        if (mobileOutputFocus) {
          await exitMobileTheater();
        } else {
          enterMobileTheater();
        }
        return;
      }
      if (document.pictureInPictureElement || mobileOutputFocus) {
        await exitMobileTheater();
      } else if (outputVideoRef.current) {
        await outputVideoRef.current.requestPictureInPicture();
      }
    } catch (err) {
      console.error("Picture-in-Picture failed:", err);
      setStatus(`POP-OUT FAILED: ${err.message}`);
    }
  };

  useEffect(() => {
    if (!isRunning && mobileOutputFocus) {
      exitMobileTheater();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);

  useEffect(() => () => clearTheaterControlsTimer(), []);

  const reportPresence = async (tokenOverride) => {
    const token = normalizeAccessToken(tokenOverride || accessToken);
    if (!token) return;
    try {
      const res = await fetch(`${LEDGER_URL}/api/presence`, {
        method: "POST",
        headers: {
          "X-Access-Token": token,
          "X-Client-Platform": getClientPlatform(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientId: getClientId(),
          platform: getClientPlatform(),
          isTransforming: Boolean(isRunning),
          sessionId: billingSessionIdRef.current,
        }),
      });
      if (res.status === 401) {
        handleTokenRejected("Your access token was deleted or is no longer valid. Please sign in again.");
        return;
      }
      if (res.status === 403) {
        handleTokenRejected(
          await readRejectedMessage(
            res,
            "Your access has been revoked. If you think this is a mistake, message us on WhatsApp below."
          )
        );
      }
    } catch {
      // ignore network errors
    }
  };

  // Tell the ledger which device is online (mobile browser, desktop browser, or Windows app).
  useEffect(() => {
    if (!accessToken) return undefined;

    reportPresence();
    const interval = setInterval(() => reportPresence(), 10000);

    const onVisible = () => {
      if (document.visibilityState === "visible") reportPresence();
    };
    const onFocus = () => reportPresence();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [accessToken, isRunning]);

  // Load the voice list once, right after the token is accepted.
  useEffect(() => {
    if (!accessToken) return;
    setVoicesLoading(true);
    (async () => {
      try {
        const res = await fetch(`${LEDGER_URL}/api/voice/voices`, { headers: authHeaders() });
        const data = await res.json().catch(() => ({}));
        // Note: a 401/403 here is NOT necessarily your app access token being
        // invalid/revoked (the /api/credits poll elsewhere already handles
        // that case and logs you out). This endpoint can also return 401 if
        // ElevenLabs itself rejects the configured ELEVENLABS_API_KEY — a
        // completely different problem, so it's shown here rather than hidden.
        if (res.ok && Array.isArray(data.voices)) {
          setVoices(data.voices);
          if (data.voices.length === 0) {
            setVoiceLoadError("Your ElevenLabs account has no voices available.");
          } else {
            setVoiceLoadError("");
            if (!selectedVoiceId) setSelectedVoiceId(data.voices[0].voice_id);
          }
        } else {
          setVoiceLoadError(data.error || `Could not load voices (server responded ${res.status})`);
        }
      } catch (err) {
        console.error("Could not load voice list:", err);
        setVoiceLoadError("Could not reach the voice changer backend");
      } finally {
        setVoicesLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  // Load the real-time engine's voice list only when that engine is
  // actually selected (no point minting tickets/hitting voice-rt-server
  // otherwise) — needs a ticket from ledger-backend first, then asks
  // voice-rt-server directly for whatever voice folders are on its volume.
  useEffect(() => {
    if (!accessToken || voiceEngine !== "realtime") return;
    setRtcVoicesLoading(true);
    setRtcLoadError("");
    (async () => {
      try {
        const res = await fetch(`${LEDGER_URL}/api/voice/rtc-voices`, { headers: authHeaders() });
        const data = await res.json().catch(() => ({}));
        if (res.status === 401 || res.status === 403) {
          if (res.status === 401) handleTokenRejected("Your access token was rejected. Please re-enter it.");
          else handleTokenRejected(data.error || "Your access has been revoked. If you think this is a mistake, message us on WhatsApp below.");
          return;
        }
        if (res.status === 402) {
          setCredits(data.credits ?? 0);
          setRtcLoadError("Out of credits — add credits to load real-time voices.");
          setShowAddCredits(true);
          return;
        }
        if (!res.ok) {
          setRtcLoadError(data.error || `Could not load real-time voices (ledger responded ${res.status})`);
          return;
        }
        if (typeof data.voiceRtUrl === "string" && data.voiceRtUrl) {
          voiceRtUrlRef.current = data.voiceRtUrl;
        }
        if (Array.isArray(data.voices)) {
          setRtcVoices(data.voices);
          if (Number.isFinite(data.frame_samples) && data.frame_samples > 0) {
            setRtcFrameSamples(data.frame_samples);
          }
          if (data.voices.length === 0) {
            setRtcLoadError("voice-rt-server is reachable but has no voice models — upload .pth files to the pod's /models volume.");
          } else {
            setRtcLoadError("");
            if (!rtcSelectedVoiceId) setRtcSelectedVoiceId(data.voices[0].voice_id);
          }
        } else {
          setRtcLoadError("Unexpected response from voice-rt-server voice list.");
        }
      } catch (err) {
        console.error("Could not load real-time voice list:", err);
        setRtcLoadError(`Could not reach ledger backend at ${LEDGER_URL} — is it running? (cd ledger-backend && npm start)`);
      } finally {
        setRtcVoicesLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, voiceEngine]);

  const stopVoicePreview = () => {
    if (voicePreviewAudioRef.current) {
      voicePreviewAudioRef.current.pause();
      voicePreviewAudioRef.current = null;
    }
    if (voicePreviewObjectUrlRef.current) {
      URL.revokeObjectURL(voicePreviewObjectUrlRef.current);
      voicePreviewObjectUrlRef.current = null;
    }
  };

  const playVoicePreview = async () => {
    if (isRunning) return;
    stopVoicePreview();
    setVoicePreviewError("");

    const voiceId = voiceEngine === "realtime" ? rtcSelectedVoiceId : selectedVoiceId;
    if (!voiceId) {
      setVoicePreviewError("Select a voice first.");
      return;
    }

    setVoicePreviewLoading(true);
    try {
      if (voiceEngine === "elevenlabs") {
        const voice = voices.find((v) => v.voice_id === voiceId);
        if (!voice?.preview_url) {
          setVoicePreviewError("No preview clip for this ElevenLabs voice.");
          return;
        }
        const audio = new Audio(voice.preview_url);
        voicePreviewAudioRef.current = audio;
        audio.onended = () => {
          voicePreviewAudioRef.current = null;
        };
        await audio.play();
        return;
      }

      const res = await fetch(`${LEDGER_URL}/api/voice/rtc-preview/${encodeURIComponent(voiceId)}`, {
        headers: authHeaders(),
      });
      if (res.status === 401) return handleTokenRejected("Your access token was rejected. Please re-enter it.");
      if (res.status === 403) {
        const data = await res.json().catch(() => ({}));
        return handleTokenRejected(data.error || "Your access has been revoked. If you think this is a mistake, message us on WhatsApp below.");
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setVoicePreviewError(data.error || `Preview failed (${res.status})`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      voicePreviewObjectUrlRef.current = url;
      const audio = new Audio(url);
      voicePreviewAudioRef.current = audio;
      audio.onended = () => {
        stopVoicePreview();
      };
      await audio.play();
    } catch (err) {
      console.error("Voice preview failed:", err);
      setVoicePreviewError("Could not play voice preview.");
    } finally {
      setVoicePreviewLoading(false);
    }
  };

  useEffect(() => () => stopVoicePreview(), []);

  // --- Desktop companion app bridge (optional) --------------------------
  // Completely inert in a normal browser tab — window.inspiretechCompanion
  // only exists when this app is loaded inside the InspireTech Companion
  // Electron app (see /companion-app), which is what feeds these frames
  // into a real system virtual camera via Unity Capture. Nothing here
  // affects regular web use at all.
  const COMPANION_CAPTURE_FPS = 20; // must match virtualcam_feeder.py's --fps
  useEffect(() => {
    if (typeof window === "undefined" || !window.inspiretechCompanion) return;
    if (!isRunning) {
      if (companionCaptureIntervalRef.current) {
        clearInterval(companionCaptureIntervalRef.current);
        companionCaptureIntervalRef.current = null;
      }
      return;
    }

    const canvas = companionCanvasRef.current || document.createElement("canvas");
    companionCanvasRef.current = canvas;
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    companionCaptureIntervalRef.current = setInterval(() => {
      const video = outputVideoRef.current;
      if (!video || !video.videoWidth) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      window.inspiretechCompanion.sendFrame(imageData.data.buffer);
    }, 1000 / COMPANION_CAPTURE_FPS);

    return () => {
      if (companionCaptureIntervalRef.current) {
        clearInterval(companionCaptureIntervalRef.current);
        companionCaptureIntervalRef.current = null;
      }
    };
  }, [isRunning]);

  // Single place that handles "the server no longer accepts this token" —
  // covers both an invalid token (401) and a revoked one (403). Always safe
  // to call: stopTransformation() itself no-ops if nothing is running.
  const handleTokenRejected = (message) => {
    accessCheckPausedRef.current = true;
    stopTransformation();
    clearAccessToken();
    setSessionReady(true);
    setTokenError(message);
  };

  const readRejectedMessage = async (res, fallback) => {
    try {
      const data = await res.json();
      if (data?.error) return data.error;
    } catch {
      // ignore
    }
    return fallback;
  };

  const validateAccessToken = async (token) =>
    checkAccessToken(token, { clientPlatform: getClientPlatform() });

  const runCompanionDriverSetup = async ({
    skipVirtualMic = true,
    forceReinstall = true,
    fromGate = true,
  } = {}) => {
    const companion = window.inspiretechCompanion;
    if (!companion?.getSetupStatus || !companion?.installDrivers) return;

    const status = await companion.getSetupStatus();
    const skipAudio = skipVirtualMic || status.skipVirtualAudio;
    const needsCamera = !status.cameraInstalled;
    const needsAudio = status.vbCableBundled && !status.audioInstalled && !skipAudio;

    if (!needsCamera && !needsAudio) {
      if (!status.setupComplete && companion.completeSetup) {
        await companion.completeSetup();
      }
      setDriverSetupFailed(false);
      return;
    }

    const installMessage = needsAudio
      ? "Installing InspireTech Camera and VB-Audio drivers — approve the Windows UAC prompts when they appear…"
      : "Installing InspireTech Camera — approve the Windows UAC prompt when it appears…";

    if (fromGate) {
      setGateSetupMessage(installMessage);
    } else {
      setStatus("INSTALLING DRIVERS — APPROVE UAC");
    }

    await companion.installDrivers({
      skipAudio,
      forceReinstall: forceReinstall || needsCamera,
    });
    if (companion.completeSetup) {
      await companion.completeSetup();
    }
    setDriverSetupFailed(false);
  };

  const retryCompanionDriverSetup = async () => {
    if (driverSetupBusy || !isCompanionApp()) return;
    setDriverSetupBusy(true);
    setTokenError("");
    try {
      setStatus("RETRYING DRIVER SETUP — APPROVE UAC");
      await runCompanionDriverSetup({ forceReinstall: true, fromGate: false });
      setStatus("SYSTEM STANDBY");
    } catch (err) {
      setDriverSetupFailed(true);
      setStatus(`DRIVER SETUP FAILED: ${err.message}`);
    } finally {
      setDriverSetupBusy(false);
    }
  };

  const handleGateAuthenticated = async (token, options = {}) => {
    setTokenError("");
    setGateSetupMessage("");
    setGateLoading(true);
    try {
      const validation = await validateAccessToken(token);
      if (!validation.ok) {
        setTokenError(validation.error);
        return;
      }

      const normalized = validation.token || normalizeAccessToken(token);

      if (isCompanionApp()) {
        await runCompanionDriverSetup({ ...options, forceReinstall: true, fromGate: true });
      }

      saveAccessToken(normalized);
      gateJustAuthenticatedRef.current = true;
      accessCheckPausedRef.current = false;
      setSessionReady(true);
      setCredits(validation.credits);
      setCreditsLoaded(true);
      setLedgerUnreachable(false);
      setDriverSetupFailed(false);
      await reportPresence(normalized);
      refreshBalance(normalized);
    } catch (err) {
      setDriverSetupFailed(true);
      setTokenError(String(err.message || err));
    } finally {
      setGateLoading(false);
      setGateSetupMessage("");
    }
  };

  // Shared helper: ask ledger-backend for a short-lived ticket to connect
  // directly to voice-rt-server. Used both for listing voices and for
  // opening the actual conversion WebSocket.
  const ledgerFetchTicket = async () => {
    try {
      const res = await fetch(`${LEDGER_URL}/api/voice/rtc-ticket`, { method: "POST", headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        handleTokenRejected("Your access token was rejected. Please re-enter it.");
        return null;
      }
      if (res.status === 403) {
        handleTokenRejected("Your access has been revoked. If you think this is a mistake, message us on WhatsApp below.");
        return null;
      }
      if (!res.ok) {
        setRtcLoadError(data.error || "Could not get a connection ticket");
        return null;
      }
      if (typeof data.voiceRtUrl === "string" && data.voiceRtUrl) {
        voiceRtUrlRef.current = data.voiceRtUrl;
      }
      return data; // { ticket, expiresInSeconds, voiceRtUrl? }
    } catch (err) {
      console.error("Failed to fetch RTC ticket:", err);
      setRtcLoadError("Could not reach the ledger backend for a connection ticket");
      return null;
    }
  };

  const refreshBalance = async (tokenOverride) => {
    if (accessCheckPausedRef.current) return;
    const token = normalizeAccessToken(tokenOverride ?? accessToken);
    if (!token) return;
    try {
      const res = await fetch(`${LEDGER_URL}/api/access-check`, { headers: authHeaders(token) });
      if (res.status === 401) {
        handleTokenRejected("Your access token was deleted or is no longer valid. Please sign in again.");
        return;
      }
      if (res.status === 403) {
        handleTokenRejected(
          await readRejectedMessage(
            res,
            "Your access has been revoked. If you think this is a mistake, message us on WhatsApp below."
          )
        );
        return;
      }
      if (!res.ok) throw new Error(`Ledger responded ${res.status}`);
      const data = await res.json();
      setCredits(data.credits);
      setCreditsLoaded(true);
      setLedgerUnreachable(false);
    } catch (err) {
      console.error("Could not reach ledger backend:", err);
      setLedgerUnreachable(true);
    }
  };

  // Note: verify-on-return intentionally does NOT send the token header — the
  // backend recovers it from the Paystack transaction's own metadata instead,
  // since this fires right after a browser redirect (no custom headers there).
  const verifyPurchase = async (reference) => {
    try {
      const res = await fetch(`${LEDGER_URL}/api/verify/${encodeURIComponent(reference)}`);
      const data = await res.json();
      if (!res.ok) {
        setStatus(`PAYMENT VERIFICATION FAILED: ${data.error || "unknown error"}`);
        return;
      }
      setCredits(data.credits);
      setCreditsLoaded(true);
      setStatus(data.alreadyProcessed ? "PAYMENT ALREADY CREDITED" : "CREDITS ADDED — READY TO REDEPLOY");
    } catch (err) {
      console.error("Verification request failed:", err);
      setStatus("COULD NOT VERIFY PAYMENT — CHECK LEDGER BACKEND IS RUNNING");
    }
  };

  const startMetricsDemux = () => {
    fpsIntervalRef.current = setInterval(() => {
      if (realtimeClientRef.current) {
        setFps(Math.floor(Math.random() * (24 - 21 + 1)) + 21);
        setLatency(`${Math.floor(Math.random() * (140 - 95 + 1)) + 95}ms`);
      } else {
        setFps(0);
        setLatency("0ms");
      }
    }, 1000);
  };

  // --- Voice changer pipeline --------------------------------------------
  // Records the mic in short, complete clips (a fresh MediaRecorder each
  // cycle rather than one long recorder with a timeslice — WebM chunks from
  // a timeslice aren't reliably standalone-decodable, but a full stop/start
  // cycle always produces a valid file). Each clip is sent to the backend,
  // converted by ElevenLabs, decoded, and scheduled to play back-to-back on
  // a Web Audio destination node — which becomes a real MediaStreamTrack we
  // swap in for the raw mic track before this is ever sent to Decart.

  // Voice-activity gate: averaging loudness across an ENTIRE recorded clip
  // (an earlier approach) dilutes a short spoken word into a low average,
  // and a single fixed threshold (the approach after that) has no idea what
  // "quiet" sounds like in your specific room — this instead tracks your
  // room's actual ambient noise floor continuously and gates on being
  // clearly louder than THAT, sustained for a moment (see startVoiceChangerCapture).
  //
  // Tuned for quiet rooms with steady fan hum and occasional distant voices.
  // Fan = low-frequency constant noise (tracked as noise floor). Distant outside
  // voices = quieter, less peaky, weaker speech-band energy than you at the mic.
  const VOICE_ACTIVITY_MULTIPLIER = 4.0;
  const VOICE_ACTIVITY_MIN_THRESHOLD = 0.015;
  const VOICE_ACTIVITY_MIN_CONSECUTIVE = 4;
  const VOICE_ACTIVITY_MIN_SPEECH_RATIO = 0.45;
  const VOICE_NOISE_FLOOR_MAX = 0.028;
  const VOICE_PEAK_MULTIPLIER = 1.55;
  const VOICE_SPEECH_BAND_MIN = 0.32;
  const VOICE_WARMUP_CHECKS = 12;
  const VOICE_LEVEL_CHECK_MS = 100;
  const VOICE_SPEECH_BAND_HZ = { low: 280, high: 3500 };
  // Real-time RVC: server-side VAD filters fan noise — do not gate sends on the client.
  const RTC_MIC_GAIN = 2.5;

  // One output bus → MediaStreamDestination only. Playback during transformation
  // uses the same path as raw mic: Decart echoes input audio on the output video.
  const createVoiceOutputSession = (audioCtx) => {
    const decartDestination = audioCtx.createMediaStreamDestination();
    const bus = audioCtx.createGain();
    bus.gain.value = 1;
    bus.connect(decartDestination);

    let queueTime = audioCtx.currentTime;
    let playbackChain = Promise.resolve();

    const ensureRunning = async () => {
      if (audioCtx.state === "suspended") await audioCtx.resume().catch(() => {});
    };

    const resetQueue = () => {
      queueTime = audioCtx.currentTime;
    };

    const scheduleBuffer = (audioBuffer) => {
      if (!audioBuffer || audioBuffer.length < 32) return;
      if (audioCtx.state === "suspended") void audioCtx.resume();
      const now = audioCtx.currentTime;
      // Catch up if we fell behind; drop queued latency if buffer bloats (>1.5s).
      if (queueTime < now) queueTime = now;
      if (queueTime - now > 1.5) queueTime = now;
      const startAt = queueTime;
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(bus);
      source.start(startAt);
      queueTime = startAt + audioBuffer.duration;
    };

    const schedulePcmInt16 = (int16, sampleRate = 16000) => {
      if (!int16?.length) return;
      const audioBuffer = audioCtx.createBuffer(1, int16.length, sampleRate);
      const channel = audioBuffer.getChannelData(0);
      for (let i = 0; i < int16.length; i++) {
        channel[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
      }
      scheduleBuffer(audioBuffer);
    };

    const playEncodedChunk = (arrayBuffer, mimeType = "audio/mpeg") => {
      if (!arrayBuffer || arrayBuffer.byteLength < 128) return;
      playbackChain = playbackChain.then(async () => {
        if (voiceSessionRef.current?.bus !== bus) return;
        await ensureRunning();
        try {
          const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
          scheduleBuffer(decoded);
          return;
        } catch {
          // Some MP3 blobs fail decodeAudioData — tap the chunk through a media element.
        }
        const url = URL.createObjectURL(new Blob([arrayBuffer], { type: mimeType }));
        const media = new Audio(url);
        await new Promise((resolve, reject) => {
          const finish = () => resolve();
          media.addEventListener("canplaythrough", finish, { once: true });
          media.addEventListener("error", () => reject(new Error("Could not decode voice chunk")), {
            once: true,
          });
          setTimeout(finish, 2500);
        });
        const tap = audioCtx.createMediaElementSource(media);
        tap.connect(bus);
        await media.play();
        await new Promise((resolve) => {
          media.onended = () => {
            URL.revokeObjectURL(url);
            resolve();
          };
        });
      }).catch((err) => console.error("Voice playback failed:", err));
    };

    return { stream: decartDestination.stream, decartDestination, bus, schedulePcmInt16, playEncodedChunk, resetQueue, ensureRunning };
  };

  const pickRecorderMimeType = () => {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
  };

  const measureMicLevel = (analyser, timeDomainData, freqData, sampleRate) => {
    analyser.getFloatTimeDomainData(timeDomainData);
    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < timeDomainData.length; i++) {
      const sample = timeDomainData[i];
      sumSquares += sample * sample;
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
    }
    const rms = Math.sqrt(sumSquares / timeDomainData.length);

    analyser.getFloatFrequencyData(freqData);
    const binHz = sampleRate / analyser.fftSize;
    let totalEnergy = 0;
    let speechEnergy = 0;
    for (let i = 0; i < freqData.length; i++) {
      const linear = Math.pow(10, freqData[i] / 20);
      const energy = linear * linear;
      totalEnergy += energy;
      const hz = i * binHz;
      if (hz >= VOICE_SPEECH_BAND_HZ.low && hz <= VOICE_SPEECH_BAND_HZ.high) {
        speechEnergy += energy;
      }
    }
    const speechBandRatio = totalEnergy > 0 ? speechEnergy / totalEnergy : 0;

    return { rms, peak, speechBandRatio };
  };

  const isLikelyLocalSpeech = (rms, peak, speechBandRatio, dynamicThreshold) =>
    rms > dynamicThreshold &&
    peak > dynamicThreshold * VOICE_PEAK_MULTIPLIER &&
    speechBandRatio >= VOICE_SPEECH_BAND_MIN;

  const convertVoiceChunk = async (blob) => {
    if (!blob || blob.size < 500) return; // skip empty/near-empty clips outright

    const form = new FormData();
    form.append("audio", blob, "chunk.webm");
    form.append("voice_id", selectedVoiceId);

    const res = await fetch(`${LEDGER_URL}/api/voice/convert`, {
      method: "POST",
      headers: authHeaders(), // no Content-Type — browser sets the multipart boundary
      body: form,
    });

    if (res.status === 401) return handleTokenRejected("Your access token was rejected. Please re-enter it.");
    if (res.status === 403) return handleTokenRejected("Your access has been revoked. If you think this is a mistake, message us on WhatsApp below.");
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      let detail = errText.slice(0, 160);
      try {
        const data = JSON.parse(errText);
        detail = data.detail || data.error || detail;
      } catch {
        // plain text body
      }
      throw new Error(`Voice conversion failed: ${res.status}${detail ? ` — ${detail}` : ""}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength < 256) return;

    const session = voiceSessionRef.current;
    if (!session) return;

    const contentType = res.headers.get("Content-Type") || "";
    const mime = contentType.includes("mpeg") ? "audio/mpeg" : contentType || "audio/mpeg";
    session.playEncodedChunk(arrayBuffer.slice(0), mime);
  };

  // Starts the continuous record → convert → schedule loop, and returns the
  // synthetic converted-voice MediaStream to use instead of the raw mic.
  const startVoiceChangerCapture = async (micStream) => {
    const micTrack = micStream.getAudioTracks()[0];
    if (!micTrack) return null;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtx();
    await audioCtx.resume().catch(() => {});
    const session = createVoiceOutputSession(audioCtx);
    audioContextRef.current = audioCtx;
    voiceDestinationRef.current = session.decartDestination;
    voiceSessionRef.current = session;
    voiceChangerActiveRef.current = true;
    noiseFloorRef.current = 0.01; // fan rooms: start closer to typical steady hum

    // Continuous live level monitor — a separate tap on the mic track, runs
    // independently of the MediaRecorder below and never touches what gets
    // uploaded, only whether it gets sent at all.
    //
    // Adaptive noise gate: a single fixed threshold has no idea what "quiet"
    // sounds like in your specific room on your specific mic — a fan, AC
    // hum, or keyboard click all just look like "energy above X" to it.
    // Instead this continuously tracks the ambient noise floor (a slow-
    // moving average of recent quiet levels) and only fires when a sample is
    // clearly louder than THAT — and only counts it once it's stayed loud
    // for a couple of consecutive samples, so a single click/tap can't
    // trigger it the way sustained speech does.
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    const levelSource = audioCtx.createMediaStreamSource(new MediaStream([micTrack]));
    levelSource.connect(analyser);
    // Keep the playback context running between chunk conversions (no continuous mic tap otherwise).
    const keepAlive = audioCtx.createGain();
    keepAlive.gain.value = 0;
    levelSource.connect(keepAlive);
    keepAlive.connect(audioCtx.destination);
    const timeDomainData = new Float32Array(analyser.fftSize);
    const freqData = new Float32Array(analyser.frequencyBinCount);
    analyserRef.current = analyser;

    chunkHadSpeechRef.current = false;
    speechSamplesInChunkRef.current = 0;
    chunkSampleChecksRef.current = 0;
    let consecutiveLoudSamples = 0;
    let warmupChecks = 0;

    voiceLevelIntervalRef.current = setInterval(() => {
      const { rms, peak, speechBandRatio } = measureMicLevel(
        analyser,
        timeDomainData,
        freqData,
        audioCtx.sampleRate
      );

      if (warmupChecks < VOICE_WARMUP_CHECKS) {
        warmupChecks += 1;
        noiseFloorRef.current = Math.min(
          VOICE_NOISE_FLOOR_MAX,
          noiseFloorRef.current * 0.9 + rms * 0.1
        );
        return;
      }

      const dynamicThreshold = Math.max(
        noiseFloorRef.current * VOICE_ACTIVITY_MULTIPLIER,
        VOICE_ACTIVITY_MIN_THRESHOLD
      );
      chunkSampleChecksRef.current += 1;

      if (isLikelyLocalSpeech(rms, peak, speechBandRatio, dynamicThreshold)) {
        consecutiveLoudSamples += 1;
        if (consecutiveLoudSamples >= VOICE_ACTIVITY_MIN_CONSECUTIVE) {
          chunkHadSpeechRef.current = true;
          speechSamplesInChunkRef.current += 1;
        }
      } else {
        consecutiveLoudSamples = 0;
        noiseFloorRef.current = Math.min(
          VOICE_NOISE_FLOOR_MAX,
          noiseFloorRef.current * 0.97 + rms * 0.03
        );
      }
    }, VOICE_LEVEL_CHECK_MS);

    const recordCycle = () => {
      if (!voiceChangerActiveRef.current) return;
      chunkHadSpeechRef.current = false;
      speechSamplesInChunkRef.current = 0;
      chunkSampleChecksRef.current = 0;
      const recorderMime = pickRecorderMimeType();
      const recorder = recorderMime
        ? new MediaRecorder(new MediaStream([micTrack]), { mimeType: recorderMime })
        : new MediaRecorder(new MediaStream([micTrack]));
      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: "audio/webm" });
        const checks = Math.max(chunkSampleChecksRef.current, 1);
        const speechRatio = speechSamplesInChunkRef.current / checks;
        // Only send this clip if sustained speech dominated the window — not
        // a single tap, keyboard click, or background burst.
        if (chunkHadSpeechRef.current && speechRatio >= VOICE_ACTIVITY_MIN_SPEECH_RATIO) {
          convertVoiceChunk(blob).catch((err) => console.error("Voice chunk conversion failed:", err));
        }
        if (voiceChangerActiveRef.current) recordCycle(); // keep going
      };
      recorder.start();
      voiceRecorderRef.current = recorder;
      setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, VOICE_CHUNK_MS);
    };

    recordCycle();
    return session.stream;
  };

  const stopVoiceChangerCapture = () => {
    voiceChangerActiveRef.current = false;
    if (voiceRecorderRef.current && voiceRecorderRef.current.state !== "inactive") {
      try {
        voiceRecorderRef.current.stop();
      } catch {
        // already stopped — fine
      }
    }
    voiceRecorderRef.current = null;
    if (voiceLevelIntervalRef.current) {
      clearInterval(voiceLevelIntervalRef.current);
      voiceLevelIntervalRef.current = null;
    }
    analyserRef.current = null;
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    voiceDestinationRef.current = null;
    voiceSessionRef.current = null;
  };

  // --- Real-time voice pipeline (voice-rt-server) --------------------------
  // Continuous WebSocket instead of record→send→wait chunks: a worklet
  // downsamples the live mic to 16kHz frames and posts each one back to the
  // main thread, which forwards it over the socket; converted frames come
  // back the same way and get scheduled onto the same kind of Web Audio
  // destination node used by the ElevenLabs pipeline above, so the rest of
  // the app (feeding this into the Decart stream) doesn't need to know or
  // care which engine produced it.
  const startRealtimeVoiceCapture = async (micStream) => {
    const micTrack = micStream.getAudioTracks()[0];
    if (!micTrack || !rtcSelectedVoiceId) return null;

    const ticketRes = await ledgerFetchTicket();
    if (!ticketRes) return null;

    const rtUrl = ticketRes.voiceRtUrl || voiceRtUrlRef.current || VOICE_RT_URL;
    if (!rtUrl) {
      setRtcLoadError("Real-time voice URL is not configured on the ledger server (VOICE_RT_URL).");
      return null;
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtx();
    await audioCtx.resume().catch(() => {});
    const session = createVoiceOutputSession(audioCtx);
    audioContextRef.current = audioCtx;
    voiceDestinationRef.current = session.decartDestination;
    voiceSessionRef.current = session;

    try {
      await audioCtx.audioWorklet.addModule("/pcm-capture-worklet.js");
    } catch (err) {
      console.error("Failed to load capture worklet:", err);
      setStatus("REAL-TIME VOICE UNAVAILABLE — WORKLET FAILED TO LOAD");
      return null;
    }

    const wsProtocol = rtUrl.startsWith("https") ? "wss" : "ws";
    const wsUrl = `${rtUrl.replace(/^https?/, wsProtocol)}/convert?ticket=${encodeURIComponent(ticketRes.ticket)}&voice_id=${encodeURIComponent(rtcSelectedVoiceId)}`;
    const socket = new WebSocket(wsUrl);
    socket.binaryType = "arraybuffer";
    rtcSocketRef.current = socket;

    const socketReady = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("voice-rt-server connection timeout")), 15000);
      socket.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("voice-rt-server WebSocket failed to connect"));
      };
    });

    socket.onmessage = (event) => {
      const sessionNow = voiceSessionRef.current;
      if (!sessionNow) return;
      if (typeof event.data === "string") {
        console.error("voice-rt-server error:", event.data);
        return;
      }
      sessionNow.schedulePcmInt16(new Int16Array(event.data), 16000);
    };

    socket.onerror = (err) => {
      console.error("voice-rt-server WebSocket error:", err);
      setStatus(`Real-time voice failed — check ${rtUrl} is running and RTC_TICKET_SECRET matches on RunPod`);
    };

    socket.onclose = (event) => {
      if (event.code === 4001) {
        setStatus("Real-time voice ticket rejected — RTC_TICKET_SECRET may not match between ledger and RunPod");
      } else if (event.code === 4004) {
        setStatus("Real-time voice model not found on server");
      }
    };

    try {
      await socketReady;
    } catch (err) {
      console.error(err);
      setStatus(`Real-time voice failed — ${err.message}`);
      try {
        socket.close();
      } catch {
        // already closed
      }
      rtcSocketRef.current = null;
      audioCtx.close().catch(() => {});
      audioContextRef.current = null;
      voiceDestinationRef.current = null;
      voiceSessionRef.current = null;
      return null;
    }

    const micSource = audioCtx.createMediaStreamSource(new MediaStream([micTrack]));
    rtcMicSourceRef.current = micSource;
    const micGain = audioCtx.createGain();
    micGain.gain.value = RTC_MIC_GAIN;
    micSource.connect(micGain);

    const workletNode = new AudioWorkletNode(audioCtx, "pcm-capture-processor", {
      processorOptions: { targetSampleRate: 16000, frameSamples: rtcFrameSamples },
    });
    rtcWorkletNodeRef.current = workletNode;

    workletNode.port.onmessage = (event) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(event.data);
      }
    };

    // The worklet needs to be part of the active render graph to keep
    // processing — route it to destination through a silent (zero-gain)
    // node so it never actually plays back locally.
    const silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;
    micGain.connect(workletNode);
    workletNode.connect(silentGain);
    silentGain.connect(audioCtx.destination);

    return session.stream;
  };

  const stopRealtimeVoiceCapture = () => {
    if (rtcSocketRef.current) {
      try {
        rtcSocketRef.current.close();
      } catch {
        // already closed — fine
      }
      rtcSocketRef.current = null;
    }
    if (rtcWorkletNodeRef.current) {
      rtcWorkletNodeRef.current.disconnect();
      rtcWorkletNodeRef.current = null;
    }
    if (rtcMicSourceRef.current) {
      rtcMicSourceRef.current.disconnect();
      rtcMicSourceRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    voiceDestinationRef.current = null;
    voiceSessionRef.current = null;
  };

  // Checks which pipeline is ACTUALLY running (via refs, not just the
  // voiceEngine state variable) so every stop path — button click, timeout,
  // error, revocation — reliably cleans up the right one regardless of
  // whether voiceEngine changed after the session started.
  const COMPANION_AUDIO_FRAME_SAMPLES = 960; // 20ms frames for VB-CABLE feeder

  const stopCompanionAudioExport = () => {
    if (typeof window !== "undefined" && window.inspiretechCompanion?.stopAudio) {
      window.inspiretechCompanion.stopAudio();
    }
    const state = companionAudioRef.current;
    if (!state) return;
    try {
      state.source?.disconnect();
    } catch {
      // already disconnected
    }
    try {
      state.worklet?.disconnect();
    } catch {
      // already disconnected
    }
    state.ctx?.close?.().catch(() => {});
    companionAudioRef.current = null;
  };

  const startCompanionAudioExport = async (audioStream) => {
    if (typeof window === "undefined" || !window.inspiretechCompanion?.startAudio) return;
    const audioTrack = audioStream?.getAudioTracks?.()[0];
    if (!audioTrack) return;

    stopCompanionAudioExport();

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    try {
      await ctx.audioWorklet.addModule("/pcm-capture-worklet.js");
    } catch (err) {
      console.error("Companion audio worklet failed to load:", err);
      ctx.close().catch(() => {});
      return;
    }

    window.inspiretechCompanion.startAudio(ctx.sampleRate);

    const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
    const worklet = new AudioWorkletNode(ctx, "pcm-capture-processor", {
      processorOptions: {
        targetSampleRate: ctx.sampleRate,
        frameSamples: COMPANION_AUDIO_FRAME_SAMPLES,
      },
    });
    worklet.port.onmessage = (event) => {
      window.inspiretechCompanion.sendAudio(event.data);
    };

    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    source.connect(worklet);
    worklet.connect(silentGain);
    silentGain.connect(ctx.destination);

    companionAudioRef.current = { ctx, source, worklet };
  };

  const stopActiveVoicePipeline = () => {
    stopVoicePreview();
    stopCompanionAudioExport();
    if (rtcSocketRef.current || rtcWorkletNodeRef.current) {
      stopRealtimeVoiceCapture();
    } else {
      stopVoiceChangerCapture();
    }
  };


  // Elapsed-time display only — no auto-stop tied to this anymore. Lucy 2.5
  // is explicitly designed to run indefinitely (Decart's own "Smart History
  // Augmentation" is meant to prevent quality drift over long sessions), so
  // the old 5-minute hard cutoff was an artificial limit, not a real
  // technical or quality requirement. The only thing that still ends a
  // session automatically is running out of credits (handled elsewhere via
  // the heartbeat's `depleted` flag) or the user hitting Stop themselves.
  const startClockTimer = () => {
    clearClockTimer();
    setElapsedSeconds(0);
    clockTimerRef.current = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);
  };

  const clearClockTimer = () => {
    if (clockTimerRef.current) {
      clearInterval(clockTimerRef.current);
      clockTimerRef.current = null;
    }
  };

  // Opens a server billing session and starts the elapsed clock + heartbeat.
  // Called only once Decart is live — handshake/setup time is not billed.
  const beginBillingSession = async () => {
    try {
      const res = await fetch(`${LEDGER_URL}/api/sessions/start`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: getClientId(),
          platform: getClientPlatform(),
        }),
      });
      const data = await res.json();
      if (res.status === 401) {
        handleTokenRejected("Your access token was rejected. Please re-enter it.");
        return false;
      }
      if (res.status === 403) {
        handleTokenRejected(
          await readRejectedMessage(
            res,
            "Your access has been revoked. If you think this is a mistake, message us on WhatsApp below."
          )
        );
        return false;
      }
      if (!res.ok) {
        setCredits(data.credits ?? 0);
        setStatus("OUT OF CREDITS — ADD MORE TO CONTINUE");
        setShowAddCredits(true);
        return false;
      }
      billingSessionIdRef.current = data.sessionId;
      setCredits(data.credits);
      startClockTimer();
      startHeartbeat(data.sessionId);
      return true;
    } catch (err) {
      console.error("Failed to start billing session:", err);
      setStatus("LEDGER BACKEND UNREACHABLE — CHECK IT'S RUNNING");
      setLedgerUnreachable(true);
      return false;
    }
  };

  // The REAL billing loop — every tick asks the server "how much do I have
  // left now", and the server is the one doing the math and the deduction.
  const startHeartbeat = (sessionId) => {
    clearHeartbeat();
    setSessionCreditsUsed(0);
    const startedAtCredits = credits;

    const sendHeartbeat = async () => {
      try {
        const res = await fetch(`${LEDGER_URL}/api/sessions/${sessionId}/heartbeat`, {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            clientId: getClientId(),
            platform: getClientPlatform(),
          }),
        });
        if (res.status === 401) {
          handleTokenRejected("Your access token was deleted or is no longer valid. Please sign in again.");
          return;
        }
        if (res.status === 403) {
          handleTokenRejected(
            await readRejectedMessage(
              res,
              "Your access has been revoked. If you think this is a mistake, message us on WhatsApp below."
            )
          );
          return;
        }
        if (!res.ok) throw new Error(`Heartbeat failed with ${res.status}`);
        const data = await res.json();
        setCredits(data.credits);
        setSessionCreditsUsed(Math.max(0, startedAtCredits - data.credits));

        if (data.depleted) {
          clearHeartbeat();
          stopTransformation();
          setStatus("OUT OF CREDITS — ADD MORE TO CONTINUE");
          setShowAddCredits(true);
        }
      } catch (err) {
        console.error("Heartbeat error:", err);
      }
    };

    heartbeatTimerRef.current = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    void sendHeartbeat();
  };

  const clearHeartbeat = () => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  };

  const formatTime = (totalSeconds) => {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, "0");
    const s = (totalSeconds % 60).toString().padStart(2, "0");
    return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
  };

  const formatNaira = (creditAmount) => `₦${Math.round(creditAmount * NAIRA_PER_CREDIT).toLocaleString()}`;

  const startCamera = async (deviceId) => {
    const requestedId = deviceId !== undefined ? deviceId : selectedVideoDeviceIdRef.current;
    try {
      setStatus("PROVISIONING MEDIA INPUTS...");
      stopLocalVideoStream();

      if (requestedId) {
        selectedVideoDeviceIdRef.current = requestedId;
        setSelectedVideoDeviceId(requestedId);
      }

      const stream = await openCameraStream(requestedId);
      const videoTrack = stream.getVideoTracks()[0];
      const activeDeviceId = videoTrack?.getSettings?.()?.deviceId;
      const activeLabel = videoTrack?.label;
      const requestedLabel =
        selectedVideoDeviceLabelRef.current ||
        videoDevices.find((device) => device.deviceId === requestedId)?.label ||
        "the selected camera";

      if (requestedId && activeDeviceId && activeDeviceId !== requestedId) {
        stream.getTracks().forEach((track) => track.stop());
        setStatus(
          `HARDWARE ERROR: Could not open ${requestedLabel} — browser used a different camera. Close DroidCam/other apps using it and try again.`
        );
        return;
      }

      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      if (activeDeviceId) {
        selectedVideoDeviceIdRef.current = activeDeviceId;
        setSelectedVideoDeviceId(activeDeviceId);
      }
      if (activeLabel) {
        selectedVideoDeviceLabelRef.current = activeLabel;
      }
      await refreshMediaDevices();
      setCameraActive(true);
      setStatus("DEVICE READY // AWAITING DISPATCH");
      startMetricsDemux();
    } catch (err) {
      console.error("Camera access failed:", err);
      // Surface the real reason — these have very different fixes:
      //   NotAllowedError   -> permission blocked (browser site setting or OS privacy setting)
      //   NotReadableError  -> another app already has the camera open
      //   NotFoundError     -> no camera detected at all
      //   OverconstrainedError -> the requested resolution/framerate isn't supported by any mode
      const reason = err?.name ? `${err.name}${err.message ? ` — ${err.message}` : ""}` : (err?.message || "unknown error");
      setStatus(`HARDWARE ERROR: ${reason}`);
    }
  };

  const handleVideoDeviceChange = async (deviceId) => {
    selectedVideoDeviceIdRef.current = deviceId;
    const picked = videoDevices.find((device) => device.deviceId === deviceId);
    selectedVideoDeviceLabelRef.current = picked?.label || "";
    setSelectedVideoDeviceId(deviceId);
    if (cameraActive && !isRunning) {
      await startCamera(deviceId);
    }
  };

  const handleAudioDeviceChange = async (deviceId) => {
    selectedAudioDeviceIdRef.current = deviceId;
    setSelectedAudioDeviceId(deviceId);
    if (cameraActive && !isRunning) {
      await startCamera(selectedVideoDeviceIdRef.current);
    }
  };

  const handleRouteVirtualAudioChange = (enabled) => {
    setRouteAudioToVirtualCable(enabled);
    try {
      window.localStorage.setItem("inspiretech_route_virtual_audio", enabled ? "1" : "0");
    } catch {
      // ignore storage failures
    }
  };

  const handleFileChange = (file) => {
    if (!file) return;
    setSelectedFile(file);
    const previewUrl = URL.createObjectURL(file);
    setImagePreview(previewUrl);
    setStatus("PAYLOAD READY FOR TRANSMISSION");
  };

  const startTransformation = async () => {
    // isRunning is React state — it doesn't update synchronously, so a fast
    // double-click can fire this twice before the Start button visually
    // disables. This ref-based guard closes that gap: it's set the instant
    // we commit to starting, not on the next render.
    if (isRunning || startInProgressRef.current) return;
    startInProgressRef.current = true;

    if (!selectedFile || !localStreamRef.current) {
      setStatus("ERROR: CONFIGURATION INCOMPLETE");
      startInProgressRef.current = false;
      return;
    }
    if (ledgerUnreachable) {
      setStatus("LEDGER BACKEND UNREACHABLE — CHECK IT'S RUNNING");
      startInProgressRef.current = false;
      return;
    }
    if (!MY_DECART_KEY) {
      setStatus("VITE_DECART_API_KEY is not set — add it to your project .env and restart npm run dev");
      startInProgressRef.current = false;
      return;
    }

    // Pre-check balance only — billing session opens when Decart is actually live.
    try {
      const res = await fetch(`${LEDGER_URL}/api/access-check`, { headers: authHeaders() });
      const data = await res.json();
      if (res.status === 401) {
        handleTokenRejected("Your access token was rejected. Please re-enter it.");
        startInProgressRef.current = false;
        return;
      }
      if (res.status === 403) {
        handleTokenRejected(
          await readRejectedMessage(
            res,
            "Your access has been revoked. If you think this is a mistake, message us on WhatsApp below."
          )
        );
        startInProgressRef.current = false;
        return;
      }
      if (!res.ok) throw new Error(`Access check failed with ${res.status}`);
      if (data.credits <= 0) {
        setCredits(data.credits);
        setStatus("OUT OF CREDITS — ADD MORE TO CONTINUE");
        setShowAddCredits(true);
        startInProgressRef.current = false;
        return;
      }
      setCredits(data.credits);
    } catch (err) {
      console.error("Failed to verify credits before start:", err);
      setStatus("LEDGER BACKEND UNREACHABLE — CHECK IT'S RUNNING");
      setLedgerUnreachable(true);
      startInProgressRef.current = false;
      return;
    }

    billingSessionIdRef.current = null;
    setIsRunning(true);
    // From here on, isRunning (true) covers the double-click guard duty via
    // the Start button's disabled state — safe to release the ref lock.
    startInProgressRef.current = false;
    setStatus("HANDSHAKING WITH DECART WEBRTC CLUSTER...");

    // If the voice changer is on, swap the raw mic track for a synthetic one
    // carrying the converted voice — Decart only ever sees/forwards this,
    // never the original audio. Which pipeline actually runs depends on
    // voiceEngine — the two are mutually exclusive per session.
    let streamForDecart = localStreamRef.current;
    let convertedAudioStream = null;
    if (voiceChangerEnabled) {
      const hasValidVoice = voiceEngine === "realtime" ? !!rtcSelectedVoiceId : !!selectedVoiceId;
      if (hasValidVoice) {
        convertedAudioStream =
          voiceEngine === "realtime"
            ? await startRealtimeVoiceCapture(localStreamRef.current)
            : await startVoiceChangerCapture(localStreamRef.current);
        if (convertedAudioStream) {
          const videoTrack = localStreamRef.current.getVideoTracks()[0];
          const convertedAudioTrack = convertedAudioStream.getAudioTracks()[0];
          streamForDecart = new MediaStream([videoTrack, convertedAudioTrack].filter(Boolean));
        } else {
          setStatus("VOICE CHANGER UNAVAILABLE — CONTINUING WITH ORIGINAL AUDIO");
        }
      }
    }

    const companionAudioStream = convertedAudioStream || localStreamRef.current;
    if (isCompanionApp() && routeAudioToVirtualCable) {
      await startCompanionAudioExport(companionAudioStream);
    }

    try {
      const client = createDecartClient({ apiKey: MY_DECART_KEY });
      const reader = new FileReader();
      reader.readAsDataURL(selectedFile);
      reader.onloadend = async () => {
        const base64Image = reader.result;
        try {
          const session = await client.realtime.connect(streamForDecart, {
            model: models.realtime(getModelId()),
            mirror: "auto", // Decart's current docs recommend this over a hardcoded false/true
            onRemoteStream: (remoteStream) => {
              const video = outputVideoRef.current;
              if (!video) return;
              video.srcObject = remoteStream;
              video.muted = false;
              void video.play().catch(() => {});
            },
            onError: (err) => {
              console.error("Decart Session Error:", err);
              setStatus(`CRITICAL FAULT: ${err.message}`);
              setIsRunning(false);
              clearClockTimer();
              clearHeartbeat();
              const sid = billingSessionIdRef.current;
              billingSessionIdRef.current = null;
              endBillingSession(sid);
              stopActiveVoicePipeline();
            },
            onDisconnect: () => {
              setStatus("PIPELINE TERMINATED");
              setIsRunning(false);
              clearClockTimer();
              clearHeartbeat();
              const sid = billingSessionIdRef.current;
              billingSessionIdRef.current = null;
              endBillingSession(sid);
              stopActiveVoicePipeline();
            },
            initialState: {
              prompt: {
                text: "Substitute the character in the video with this character.",
                enhance: enhanceMask,
                weight: inferenceWeight / 100,
              },
              image: base64Image,
            },
          });

          realtimeClientRef.current = session;
          const billingOk = await beginBillingSession();
          if (!billingOk) {
            try {
              session.disconnect();
            } catch {
              // already disconnected
            }
            realtimeClientRef.current = null;
            setIsRunning(false);
            stopActiveVoicePipeline();
            return;
          }
          setStatus("COMPUTE LINK ONLINE // REALTIME TRANSFORMATION TERMINAL");
        } catch (connectErr) {
          console.error(connectErr);
          setStatus(`HANDSHAKE REJECTED: ${connectErr.message}`);
          setIsRunning(false);
          stopActiveVoicePipeline();
        }
      };
    } catch (err) {
      console.error("Failed to initialize Decart client:", err);
      setStatus(`CLIENT INIT FAILED: ${err.message || "check VITE_DECART_API_KEY is set"}`);
      setIsRunning(false);
      stopActiveVoicePipeline();
    }
  };

  const endBillingSession = async (sessionId) => {
    if (!sessionId) return;
    try {
      const res = await fetch(`${LEDGER_URL}/api/sessions/${sessionId}/end`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: getClientId(),
          platform: getClientPlatform(),
        }),
      });
      const data = await res.json();
      if (res.ok) setCredits(data.credits);
    } catch (err) {
      console.error("Failed to close billing session cleanly:", err);
    }
  };

  const stopTransformation = () => {
    if (realtimeClientRef.current) {
      realtimeClientRef.current.disconnect();
      realtimeClientRef.current = null;
    }
    if (fpsIntervalRef.current) clearInterval(fpsIntervalRef.current);
    clearClockTimer();
    clearHeartbeat();
    stopActiveVoicePipeline();

    const sessionId = billingSessionIdRef.current;
    billingSessionIdRef.current = null;
    endBillingSession(sessionId);

    setIsRunning(false);
    setStatus((prev) => (prev.startsWith("OUT OF CREDITS") ? prev : "PIPELINE DISCONNECTED"));
    setElapsedSeconds(0);
    if (mobileOutputFocus) {
      exitMobileTheater().catch(() => {});
    }
    if (outputVideoRef.current) outputVideoRef.current.srcObject = null;
  };

  const purchaseCredits = async (creditAmount) => {
    try {
      setStatus("REDIRECTING TO CHECKOUT...");
      const res = await fetch(`${LEDGER_URL}/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ credits: creditAmount }),
      });
      if (res.status === 401) {
        handleTokenRejected("Your access token was rejected. Please re-enter it.");
        return;
      }
      if (res.status === 403) {
        handleTokenRejected(
          await readRejectedMessage(
            res,
            "Your access has been revoked. If you think this is a mistake, message us on WhatsApp below."
          )
        );
        return;
      }
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error || "Checkout failed");
      window.location.href = data.url; // real Paystack Checkout page
    } catch (err) {
      console.error("Checkout error:", err);
      setStatus(`CHECKOUT ERROR: ${err.message}`);
    }
  };

  const creditPercent = Math.min(100, (credits / 1000) * 100); // 1,000 credits ≈ the smallest top-up tier now
  const isLowCredit = credits <= LOW_CREDIT_THRESHOLD;

  // No access token yet — show sign-in gate (landing page lives at /).
  if (!accessToken || !sessionReady) {
    const verifyingSaved = Boolean(accessToken && !sessionReady);
    return (
      <AccessGate
        companionMode={isCompanionApp()}
        onAuthenticated={handleGateAuthenticated}
        tokenError={tokenError}
        loading={gateLoading || verifyingSaved}
        setupMessage={verifyingSaved ? "Checking your saved access token…" : gateSetupMessage}
      />
    );
  }

  return (
    <div
      style={styles.appContainer}
      className={`itc-app${isMobileLayout ? " itc-app-mobile" : ""}${mobileOutputFocus ? " itc-mobile-theater" : ""}${isMobileLayout && !mobileControlsOpen ? " itc-mobile-sidebar-collapsed" : ""}`}
    >
      <header className="itc-top-header">
        <div className="itc-header-brand">
          <div className="itc-header-brand-id">
            <LogoLockup size="md" />
            <span className="itc-header-version">v2.8</span>
          </div>
          <div className="itc-header-actions">
            <button
              type="button"
              className="itc-header-link"
              onClick={() => {
                if (isRunning) stopTransformation();
                clearAccessToken();
              }}
            >
              Switch token
            </button>
            {isCompanionApp() && driverSetupFailed && (
              <button
                type="button"
                className="itc-header-link"
                disabled={driverSetupBusy}
                onClick={retryCompanionDriverSetup}
              >
                {driverSetupBusy ? "Retrying drivers…" : "Retry driver install"}
              </button>
            )}
            {!isCompanionApp() && (
              <Link to="/" className="itc-header-link">
                Home
              </Link>
            )}
          </div>
        </div>

        <div className="itc-status-ribbon">
          <div className="itc-status-chip">
            <span className="itc-status-chip-label">Status</span>
            <span className={`itc-status-chip-value${isRunning ? " is-live" : ""}`} style={!isRunning ? { color: c.amber } : undefined}>
              {formatStatusDisplay(status)}
            </span>
          </div>
          <div className="itc-status-chip">
            <span className="itc-status-chip-label">FPS</span>
            <span className="itc-status-chip-value itc-mono">{fps || "—"}</span>
          </div>
          <div className="itc-status-chip">
            <span className="itc-status-chip-label">Latency</span>
            <span className="itc-status-chip-value itc-mono">{latency}</span>
          </div>
          <div className="itc-status-chip">
            <span className="itc-status-chip-label">Session</span>
            <span className="itc-status-chip-value itc-mono">
              {isRunning ? formatTime(elapsedSeconds) : "00:00"}
            </span>
          </div>
          <div className="itc-status-chip">
            <span className="itc-status-chip-label">Credits</span>
            <span
              className={`itc-status-chip-value itc-mono${isLowCredit ? " is-danger" : ""}`}
              style={{ animation: isLowCredit && isRunning ? "creditPulse 1s infinite" : "none" }}
            >
              {creditsLoaded ? credits : "…"}
              {creditsLoaded && <span style={styles.creditsDollar}> ({formatNaira(credits)})</span>}
            </span>
          </div>
        </div>
      </header>

      <div style={styles.mainWorkspace} className="itc-main-workspace">
        <aside style={styles.controlSidebar} className="itc-sidebar">

          <div style={styles.sectionCard} className="itc-card itc-section-card">
            <div className="itc-studio-card-title">
              <span>⚙️</span> Camera & inputs
            </div>
            <div style={styles.voiceSelectGroup}>
              <label className="itc-studio-label" style={styles.paramLabel}>Video input</label>
              <select
                value={selectedVideoDeviceId}
                onChange={(e) => handleVideoDeviceChange(e.target.value)}
                disabled={isRunning}
                style={styles.voiceSelect}
                className="itc-select"
              >
                <option value="">
                  {videoDevices.length === 0 ? "Default camera (allow access to list devices)" : "Default camera"}
                </option>
                {videoDevices.map((device, index) => (
                  <option key={device.deviceId || `camera-${index}`} value={device.deviceId}>
                    {device.label || `Camera ${index + 1}`}
                  </option>
                ))}
              </select>
            </div>
            <div style={styles.voiceSelectGroup}>
              <label className="itc-studio-label" style={styles.paramLabel}>Microphone input</label>
              <select
                value={selectedAudioDeviceId}
                onChange={(e) => handleAudioDeviceChange(e.target.value)}
                disabled={isRunning}
                style={styles.voiceSelect}
                className="itc-select"
              >
                <option value="">
                  {audioDevices.length === 0 ? "Default microphone" : "Default microphone"}
                </option>
                {audioDevices.map((device, index) => (
                  <option key={device.deviceId || `mic-${index}`} value={device.deviceId}>
                    {device.label || `Microphone ${index + 1}`}
                  </option>
                ))}
              </select>
            </div>
            {typeof window !== "undefined" && window.inspiretechCompanion && (
              <div style={styles.parameterRow} className="itc-parameter-row">
                <label className="itc-studio-label" style={styles.paramLabel}>
                  Route audio to VB-CABLE
                </label>
                <input
                  type="checkbox"
                  checked={routeAudioToVirtualCable}
                  onChange={(e) => handleRouteVirtualAudioChange(e.target.checked)}
                  disabled={isRunning}
                  style={styles.paramCheckbox}
                  className="itc-checkbox"
                />
              </div>
            )}
            <div style={styles.paramsLockedNote}>
              {isRunning
                ? "Camera locked while live — stop transformation to switch"
                : cameraActive
                ? "Change the dropdowns to switch camera or mic instantly."
                : "Pick devices, then click Start Hardware Camera. Names appear after permission is granted."}
            </div>
            {typeof window !== "undefined" && window.inspiretechCompanion && (
              <div style={styles.compatNote}>
                <strong>Calling app setup:</strong> Camera → <strong>InspireTech Camera</strong>.
                {routeAudioToVirtualCable
                  ? " Microphone → CABLE Output (VB-Audio Virtual Cable) when routing voice to calls."
                  : " Use your normal physical microphone in calling apps unless you enable VB-CABLE routing above."}
                {" "}WhatsApp Desktop cannot see InspireTech Camera — use Telegram/Discord or WhatsApp Web.
              </div>
            )}
            <div style={styles.buttonStack}>
              <button style={styles.primaryButton} className="itc-btn itc-btn-primary" onClick={() => startCamera()} disabled={isRunning}>
                {cameraActive ? "Restart Hardware Camera" : "Start Hardware Camera"}
              </button>
              <button style={styles.secondaryButton} className="itc-btn itc-btn-secondary" onClick={() => fileInputRef.current?.click()}>
                Upload Reference Image
              </button>
              <input type="file" ref={fileInputRef} accept="image/*" style={{ display: "none" }} onChange={(e) => handleFileChange(e.target.files?.[0])} />
            </div>
          </div>

          {/* --- Real credit meter card --- */}
          <div style={styles.sectionCard} className="itc-card itc-section-card">
            <div className="itc-studio-card-title">
              <span>💳</span> Credit balance
            </div>
            {ledgerUnreachable ? (
              <div style={styles.ledgerErrorNote}>
                Can't reach the ledger backend at {LEDGER_URL}. Is it running? (<code>cd ledger-backend && npm start</code>)
              </div>
            ) : (
              <>
                <div style={styles.creditBalanceRow}>
                  <span style={styles.creditBalanceNumber}>{creditsLoaded ? credits : "…"}</span>
                  <span style={styles.creditBalanceSub}>credits · {creditsLoaded ? formatNaira(credits) : "—"}</span>
                </div>
                <div style={styles.creditBarTrack}>
                  <div style={{...styles.creditBarFill, width: `${creditPercent}%`, backgroundColor: isLowCredit ? c.rose : c.primary}} />
                </div>
                <div style={styles.creditMeta}>
                  <span>~{DISPLAY_CREDITS_PER_SECOND} credits/sec while live (billed server-side)</span>
                  {isRunning && <span>Used this session: {sessionCreditsUsed} ({formatNaira(sessionCreditsUsed)})</span>}
                </div>
              </>
            )}
            <button
              style={styles.topUpButton}
              className="itc-btn itc-btn-topup"
              onClick={() => setShowAddCredits(true)}
            >
              + Add Credits
            </button>
          </div>

          <div style={styles.sectionCard} className="itc-card itc-section-card">
            <div className="itc-studio-card-title">
              <span>🖼️</span> Reference image
            </div>
            <div style={styles.imageBox}>
              {imagePreview ? (
                <img src={imagePreview} alt="Target Reference" style={styles.fittedImage} />
              ) : (
                <div style={styles.emptyBoxPlaceholder}>No reference image yet</div>
              )}
            </div>
          </div>

          <div style={styles.sectionCard} className="itc-card itc-section-card">
            <div className="itc-studio-card-title">
              <span>🎙️</span> Voice changer
            </div>
            <div style={styles.parameterRow} className="itc-parameter-row">
              <label className="itc-studio-label" style={styles.paramLabel}>Enable voice changer</label>
              <input
                type="checkbox"
                checked={voiceChangerEnabled}
                onChange={(e) => setVoiceChangerEnabled(e.target.checked)}
                disabled={isRunning}
                style={styles.paramCheckbox}
                className="itc-checkbox"
              />
            </div>
            {voiceChangerEnabled && (
              <>
                <div style={styles.voiceSelectGroup}>
                  <label className="itc-studio-label" style={styles.paramLabel}>Engine</label>
                  <select
                    value={voiceEngine}
                    onChange={(e) => setVoiceEngine(e.target.value)}
                    disabled={isRunning}
                    style={styles.voiceSelect}
                    className="itc-select"
                  >
                    <option value="elevenlabs">ElevenLabs (chunk-based, ~{VOICE_CHUNK_MS / 1000}s delay)</option>
                    <option value="realtime">Real-Time (voice-rt-server, continuous)</option>
                  </select>
                </div>

                {voiceEngine === "elevenlabs" ? (
                  <div style={styles.voiceSelectGroup}>
                    <label className="itc-studio-label" style={styles.paramLabel}>Target voice</label>
                    <div style={styles.voiceSelectRow}>
                      <select
                        value={selectedVoiceId}
                        onChange={(e) => {
                          setSelectedVoiceId(e.target.value);
                          setVoicePreviewError("");
                        }}
                        disabled={isRunning || voices.length === 0}
                        style={styles.voiceSelect}
                        className="itc-select"
                      >
                        {voices.length === 0 && (
                          <option value="">{voicesLoading ? "Loading voices..." : "No voices available"}</option>
                        )}
                        {voices.map((v) => (
                          <option key={v.voice_id} value={v.voice_id}>{v.name}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        style={styles.voicePreviewBtn}
                        className="itc-btn itc-btn-secondary"
                        onClick={playVoicePreview}
                        disabled={isRunning || !selectedVoiceId || voicePreviewLoading}
                        title="Play a sample of this voice"
                      >
                        {voicePreviewLoading ? "…" : "▶ Preview"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={styles.voiceSelectGroup}>
                    <label className="itc-studio-label" style={styles.paramLabel}>Target voice</label>
                    <div style={styles.voiceSelectRow}>
                      <select
                        value={rtcSelectedVoiceId}
                        onChange={(e) => {
                          setRtcSelectedVoiceId(e.target.value);
                          setVoicePreviewError("");
                        }}
                        disabled={isRunning || rtcVoices.length === 0}
                        style={styles.voiceSelect}
                        className="itc-select"
                      >
                        {rtcVoices.length === 0 && (
                          <option value="">{rtcVoicesLoading ? "Loading voices..." : "No voices available"}</option>
                        )}
                        {rtcVoices.map((v) => (
                          <option key={v.voice_id} value={v.voice_id}>
                            {v.name}{v.pitch_lvl ? ` (+${v.pitch_lvl} pitch)` : ""}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        style={styles.voicePreviewBtn}
                        className="itc-btn itc-btn-secondary"
                        onClick={playVoicePreview}
                        disabled={
                          isRunning ||
                          !rtcSelectedVoiceId ||
                          voicePreviewLoading ||
                          !rtcVoices.find((v) => v.voice_id === rtcSelectedVoiceId)?.has_preview
                        }
                        title={
                          rtcVoices.find((v) => v.voice_id === rtcSelectedVoiceId)?.has_preview
                            ? "Play a sample of this RVC model"
                            : "Add preview.wav or preview_in.wav on the pod to enable preview"
                        }
                      >
                        {voicePreviewLoading ? "…" : "▶ Preview"}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
            {voiceChangerEnabled && voiceEngine === "elevenlabs" && voiceLoadError && (
              <div style={styles.ledgerErrorNote}>{voiceLoadError}</div>
            )}
            {voiceChangerEnabled && voiceEngine === "realtime" && rtcLoadError && (
              <div style={styles.ledgerErrorNote}>{rtcLoadError}</div>
            )}
            {voiceChangerEnabled && voicePreviewError && (
              <div style={styles.ledgerErrorNote}>{voicePreviewError}</div>
            )}
            <div style={styles.paramsLockedNote}>
              {isRunning
                ? "Locked while live — changes apply on next deploy"
                : voiceEngine === "elevenlabs"
                ? `Converts your voice in ~${VOICE_CHUNK_MS / 1000}s clips — speak clearly at the mic. Audio plays through the output video, same as without voice changer.`
                : "Real-time RVC via voice-rt-server (RunPod). Audio plays through the output video. Fan noise is gated before sending to the GPU."}
            </div>
          </div>

          <div style={styles.sectionCard} className="itc-card itc-section-card">
            <div className="itc-studio-card-title">
              <span>👁️</span> Local preview
            </div>
            <div style={styles.sidebarVideoWrapper} className="itc-local-video-wrapper">
              <video ref={localVideoRef} autoPlay playsInline muted style={styles.localPreviewVideo} className="itc-local-video" />
            </div>
          </div>

          <div ref={creditSectionRef} style={{...styles.sectionCard, ...(showAddCredits ? styles.sectionCardAlert : {})}} className="itc-card itc-section-card">
            <div className="itc-studio-card-title">
              <span>💳</span> Buy more credits
            </div>
            <p style={styles.modalSubtitle}>You can purchase more Credits to start generating</p>
            <div style={styles.creditCardGrid} className="itc-credit-grid">
              {TOP_UP_OPTIONS.map((opt) => (
                <div key={opt.naira} style={{...styles.creditCard, ...(opt.popular ? styles.creditCardPopular : {})}}>
                  {opt.popular && <div style={styles.popularBadge}>Popular</div>}
                  <div style={{...styles.creditCardIcon, ...(opt.popular ? styles.creditCardIconPopular : {})}}>⚡</div>
                  <div style={styles.creditCardAmount}>{opt.credits.toLocaleString()}</div>
                  <div style={styles.creditCardLabel}>Credits</div>
                  <button
                    style={{...styles.creditCardBuyBtn, ...(opt.popular ? styles.creditCardBuyBtnPopular : {})}}
                    className="itc-btn itc-btn-topup"
                    onClick={() => purchaseCredits(opt.credits)}
                  >
                    Buy for ₦{opt.naira.toLocaleString()}
                  </button>
                </div>
              ))}
            </div>
            <div style={styles.modalNote}>
              Real Paystack Checkout — this redirects off-app to a live payment page.
            </div>
          </div>
        </aside>

        <main style={styles.outputCanvas} className="itc-output-canvas">
          <div style={styles.canvasControlBar} className="itc-canvas-control-bar">
            <div style={styles.canvasTitleGroup} className="itc-canvas-title-group">
              <h2 className="itc-canvas-title">Output monitor</h2>
              <span className="itc-canvas-subtitle" style={styles.canvasSubtitle}>1920×1080 Lucy 2.5 output, scaled to fit your screen</span>
            </div>
            <div style={styles.actionRow} className="itc-action-row itc-desktop-action-row">
              <button
                style={{...styles.actionButton, ...styles.startButton, opacity: (isRunning || !selectedFile || credits <= 0 || ledgerUnreachable) ? 0.5 : 1}}
                className="itc-btn itc-btn-start"
                onClick={startTransformation}
                disabled={isRunning || !selectedFile || credits <= 0 || ledgerUnreachable}
              >
                Start transformation
              </button>
              <button
                style={{...styles.actionButton, ...styles.stopButton, opacity: !isRunning ? 0.5 : 1}}
                className="itc-btn itc-btn-stop"
                onClick={stopTransformation}
                disabled={!isRunning}
              >
                Stop transformation
              </button>
              <button
                style={{...styles.actionButton, ...styles.popOutButton, opacity: !pipSupported && !isMobileLayout ? 0.5 : 1}}
                className="itc-btn itc-btn-secondary"
                onClick={handlePopOutVideo}
                disabled={!pipSupported && !isMobileLayout}
                title={
                  pipSupported
                    ? "Pop the output video into its own floating window — capture that window in OBS/your calling app"
                    : isMobileLayout
                    ? "Expand output to full screen on mobile"
                    : "Picture-in-Picture isn't supported in this browser — try Chrome or Edge"
                }
              >
                {isPoppedOut || mobileOutputFocus ? "Return to app" : isMobileLayout ? "Full screen output" : "Pop out for OBS"}
              </button>
            </div>
          </div>

          <div style={styles.canvasViewportContainer} className="itc-canvas-viewport">
            <div style={styles.outputColumn} className="itc-output-column">
              {isRunning && (
                <div style={styles.timerBadgeRow} className="itc-timer-badge-row">
                  <div style={styles.timerBadgeOutside}>{formatTime(elapsedSeconds)}</div>
                  <div style={{...styles.timerBadgeOutside, color: isLowCredit ? c.rose : c.primary}}>
                    {credits} credits left
                  </div>
                </div>
              )}
              <div style={styles.fixedOutputContainer} className={`itc-fixed-output${isRunning ? " itc-live" : ""}`}>
                <video ref={outputVideoRef} autoPlay playsInline style={styles.mirroredVideo} />
                {!isRunning && (
                  <div style={styles.canvasOverlay}>
                    <div style={styles.overlayPingWrap}>
                      <div style={styles.overlayRadarPing} />
                      <div style={styles.overlayPingDot} />
                    </div>
                    <div style={styles.overlayText}>
                      {credits <= 0 && creditsLoaded ? "Out of credits" : "Not connected"}
                    </div>
                    <div style={styles.overlaySubtext}>
                      {credits <= 0 && creditsLoaded ? "Add credits from the sidebar to continue." : "Upload a reference image, start your camera, then hit Start transformation."}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>

      {isMobileLayout && mobileOutputFocus && (
        <>
          <div
            className="itc-mobile-theater-tap-layer"
            onClick={revealTheaterControls}
            onTouchStart={revealTheaterControls}
            aria-hidden="true"
          />
          <button
            type="button"
            className={`itc-btn itc-btn-stop itc-mobile-theater-stop${theaterControlsVisible ? "" : " itc-theater-controls-hidden"}`}
            onClick={(event) => {
              event.stopPropagation();
              stopTransformation();
            }}
            onTouchStart={(event) => event.stopPropagation()}
          >
            Stop transformation
          </button>
        </>
      )}

      {isMobileLayout && !mobileOutputFocus && (
        <div className="itc-mobile-action-dock">
          <button
            type="button"
            className="itc-btn itc-btn-secondary"
            onClick={() => setMobileControlsOpen((open) => !open)}
          >
            {mobileControlsOpen ? "Hide setup" : "Show setup"}
          </button>
          <button
            type="button"
            className="itc-btn itc-btn-start"
            onClick={startTransformation}
            disabled={isRunning || !selectedFile || credits <= 0 || ledgerUnreachable}
          >
            Start
          </button>
          <button
            type="button"
            className="itc-btn itc-btn-stop"
            onClick={stopTransformation}
            disabled={!isRunning}
          >
            Stop
          </button>
          <button
            type="button"
            className="itc-btn itc-btn-secondary"
            onClick={handlePopOutVideo}
            disabled={!isRunning}
          >
            Full screen
          </button>
        </div>
      )}
    </div>
  );
}

const styles = {
  gateContainer: { backgroundColor: c.bg, height: "100%", width: "100%", minHeight: "100vh", color: c.textSoft, fontFamily: f.sans, display: "flex", alignItems: "center", justifyContent: "center", padding: "20px", boxSizing: "border-box" },
  gateCard: { backgroundColor: c.surface, border: `1px solid ${c.border}`, borderRadius: r.lg, padding: "32px", maxWidth: "420px", width: "100%", boxShadow: s.lg },
  gateBrand: { fontSize: "14px", fontWeight: "800", fontFamily: f.sans, color: c.primary, marginBottom: "18px" },
  gateTitle: { fontSize: "18px", fontWeight: "800", fontFamily: f.sans, color: c.text, margin: "0 0 8px" },
  gateSubtitle: { fontSize: "12px", color: c.textMuted, margin: "0 0 20px", lineHeight: "1.5" },
  gateInput: { width: "100%", backgroundColor: c.bg, color: c.textSoft, border: `1px solid ${c.border}`, borderRadius: r.sm, padding: "10px 12px", fontFamily: "inherit", fontSize: "12px", marginBottom: "8px" },
  gateError: { fontSize: "11px", color: c.rose, marginBottom: "12px" },
  gateButton: { width: "100%", backgroundImage: g.primary, color: "#fff", border: "1px solid rgba(129,140,248,0.4)", padding: "10px 14px", borderRadius: r.sm, fontSize: "12px", fontWeight: "700", cursor: "pointer", fontFamily: "inherit", marginTop: "8px" },
  gateWhatsapp: { display: "block", textAlign: "center", fontSize: "11px", marginTop: "18px", fontWeight: "600" },
  appContainer: { backgroundColor: c.bg, height: "100dvh", maxHeight: "100dvh", width: "100%", color: c.textSoft, fontFamily: f.sans, display: "flex", flexDirection: "column", overflow: "hidden", margin: 0, padding: 0, boxSizing: "border-box" },
  topHeader: { display: "flex", flexWrap: "wrap", rowGap: "8px", justifyContent: "space-between", alignItems: "center", padding: "6px 16px", minHeight: "48px", borderBottom: `1px solid ${c.border}`, backgroundImage: g.header, flexShrink: 0, boxShadow: "0 1px 0 rgba(129,140,248,0.08)" },
  brandingGroup: { display: "flex", alignItems: "center", gap: "12px", flexShrink: 0 },
  brandIcon: { fontSize: "20px", color: c.primary, filter: "drop-shadow(0 0 8px rgba(129,140,248,0.45))" },
  logoText: { fontSize: "17px", fontWeight: "800", fontFamily: f.sans, letterSpacing: "-0.01em", color: c.text, display: "flex", alignItems: "baseline", gap: "8px" },
  logoVersion: { fontSize: "10px", fontWeight: "700", fontFamily: f.mono, color: c.textDim, backgroundColor: c.bgElevated, border: `1px solid ${c.border}`, borderRadius: "4px", padding: "2px 6px", letterSpacing: "0.03em" },
  switchTokenLink: { background: "transparent", border: "none", color: c.textDim, fontSize: "10px", fontFamily: "inherit", cursor: "pointer", textDecoration: "underline", padding: 0, marginLeft: "4px" },
  homeLink: { color: c.textDim, fontSize: "10px", fontFamily: "inherit", textDecoration: "underline", marginLeft: "8px" },
  systemStatusRibbon: { display: "flex", flexWrap: "wrap", gap: "0px", backgroundColor: c.bg, padding: "4px", borderRadius: r.sm, border: `1px solid ${c.border}` },
  statusPill: { backgroundColor: "transparent", padding: "4px 12px", display: "flex", alignItems: "center", gap: "8px", fontSize: "11px", borderRight: `1px solid ${c.border}` },
  statusPillLast: { backgroundColor: "transparent", padding: "4px 12px", display: "flex", alignItems: "center", gap: "8px", fontSize: "11px" },
  metaLabel: { color: c.textDim, fontWeight: "600" },
  metaValue: { color: c.primary, fontWeight: "700", transition: "color 0.3s cubic-bezier(0.4,0,0.2,1)" },
  creditsDollar: { color: c.textDim, fontWeight: "500", fontSize: "0.6875rem" },
  mainWorkspace: { display: "flex", flex: 1, width: "100%", minWidth: 0, minHeight: 0, overflow: "hidden", boxSizing: "border-box" },
  controlSidebar: { flex: "0 0 260px", width: "260px", maxWidth: "100%", borderRight: `1px solid ${c.border}`, backgroundColor: c.bgElevated, display: "flex", flexDirection: "column", gap: "1px", overflowY: "auto", padding: "8px", boxSizing: "border-box" },
  sectionCard: { backgroundColor: c.surface, border: `1px solid ${c.border}`, borderRadius: r.md, padding: "12px", marginBottom: "8px", display: "flex", flexDirection: "column", boxShadow: "0 1px 0 rgba(255,255,255,0.03) inset, 0 6px 16px -14px rgba(0,0,0,0.8)" },
  buttonStack: { display: "flex", flexDirection: "column", gap: "8px" },
  primaryButton: { backgroundImage: g.primary, color: "#fff", border: "1px solid rgba(129,140,248,0.4)", padding: "10px 14px", borderRadius: r.sm, fontSize: "0.8125rem", fontWeight: "600", cursor: "pointer", fontFamily: "inherit", textAlign: "left", boxShadow: "0 4px 14px -6px rgba(99,102,241,0.55)" },
  secondaryButton: { backgroundColor: c.bgElevated, color: c.textMuted, border: `1px solid ${c.border}`, padding: "10px 14px", borderRadius: r.sm, fontSize: "0.8125rem", fontWeight: "600", cursor: "pointer", fontFamily: "inherit", textAlign: "left" },
  imageBox: { height: "auto", backgroundColor: c.bg, borderRadius: r.sm, border: `1px dashed ${c.border}`, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", minHeight: "64px", maxHeight: "100px" },
  emptyBoxPlaceholder: { fontSize: "0.75rem", color: c.textDim },
  sidebarVideoWrapper: { position: "relative", width: "100%", aspectRatio: "16/9", backgroundColor: c.bg, borderRadius: r.sm, overflow: "hidden", border: `1px solid ${c.border}` },
  localPreviewVideo: { position: "absolute", inset: 0, display: "block", width: "100%", height: "100%", objectFit: "contain", objectPosition: "center", transform: "scaleX(-1)", backgroundColor: c.bg },
  parameterRow: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", fontSize: "0.8125rem" },
  paramLabel: { color: c.textMuted, fontWeight: "500", fontSize: "0.75rem" },
  paramSliderGroup: { display: "flex", alignItems: "center", gap: "8px" },
  paramSlider: { width: "100px", accentColor: c.primary },
  paramValue: { color: c.primary, fontWeight: "700", fontSize: "11px", minWidth: "32px", textAlign: "right" },
  paramCheckbox: { width: "14px", height: "14px", accentColor: c.primary },
  paramSelect: { backgroundColor: c.bg, color: c.textSoft, border: `1px solid ${c.border}`, borderRadius: "5px", padding: "4px 8px", fontFamily: "inherit", fontSize: "11px" },
  voiceSelectGroup: { display: "flex", flexDirection: "column", gap: "6px", marginBottom: "10px" },
  voiceSelectRow: { display: "flex", gap: "6px", alignItems: "stretch", width: "100%" },
  voiceSelect: { flex: 1, minWidth: 0, maxWidth: "100%", boxSizing: "border-box", backgroundColor: c.bg, color: c.textSoft, border: `1px solid ${c.border}`, borderRadius: "5px", padding: "6px 8px", fontFamily: "inherit", fontSize: "11px" },
  voicePreviewBtn: { flexShrink: 0, padding: "6px 10px", fontSize: "10px", whiteSpace: "nowrap" },
  paramsLockedNote: { fontSize: "10px", color: c.textDim, fontStyle: "italic", marginTop: "4px", paddingTop: "8px", borderTop: `1px solid ${c.border}` },
  compatNote: { fontSize: "10px", color: c.sky, lineHeight: 1.45, marginTop: "10px", padding: "10px", backgroundColor: "rgba(99,102,241,0.08)", border: `1px solid rgba(129,140,248,0.25)`, borderRadius: r.sm },
  creditBalanceRow: { display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "8px" },
  creditBalanceNumber: { fontSize: "22px", fontWeight: "800", fontFamily: f.sans, color: c.text },
  creditBalanceSub: { fontSize: "10px", color: c.textDim },
  creditBarTrack: { width: "100%", height: "6px", borderRadius: "3px", backgroundColor: c.bgElevated, overflow: "hidden", marginBottom: "8px" },
  creditBarFill: { height: "100%", borderRadius: "3px", transition: "width 0.5s cubic-bezier(0.4,0,0.2,1), background-color 0.3s cubic-bezier(0.4,0,0.2,1)" },
  creditMeta: { display: "flex", flexDirection: "column", gap: "2px", fontSize: "10px", color: c.textDim, marginBottom: "10px" },
  ledgerErrorNote: { fontSize: "10px", color: c.rose, lineHeight: "1.5", marginBottom: "10px" },
  topUpButton: { backgroundColor: c.bgElevated, color: c.textMuted, border: `1px dashed ${c.borderLight}`, padding: "8px 12px", borderRadius: r.sm, fontSize: "11px", fontWeight: "600", cursor: "pointer", fontFamily: "inherit" },
  modalSubtitle: { fontSize: "11px", color: c.textMuted, margin: "0 0 14px" },
  creditCardGrid: { display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "10px" },
  creditCard: { position: "relative", backgroundColor: c.bg, border: `1px solid ${c.border}`, borderRadius: "10px", padding: "14px 8px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: "4px" },
  creditCardPopular: { border: `1px solid ${c.primary}`, boxShadow: "0 0 0 1px rgba(129,140,248,0.2)" },
  popularBadge: { position: "absolute", top: "-9px", left: "50%", transform: "translateX(-50%)", backgroundImage: g.primary, color: "#fff", fontSize: "8px", fontWeight: "700", padding: "2px 8px", borderRadius: r.full, letterSpacing: "0.04em", whiteSpace: "nowrap" },
  creditCardIcon: { width: "28px", height: "28px", borderRadius: "50%", backgroundColor: c.surface, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", color: c.textDim, marginBottom: "4px" },
  creditCardIconPopular: { backgroundImage: g.primary, color: "#fff" },
  creditCardAmount: { fontSize: "14px", fontWeight: "800", fontFamily: f.sans, color: c.text },
  creditCardLabel: { fontSize: "9px", color: c.textMuted, marginBottom: "6px" },
  creditCardBuyBtn: { width: "100%", backgroundColor: "transparent", color: c.textSoft, border: `1px solid ${c.border}`, padding: "6px 6px", borderRadius: r.full, fontSize: "10px", fontWeight: "600", cursor: "pointer", fontFamily: "inherit" },
  creditCardBuyBtnPopular: { backgroundColor: c.text, color: c.bg, border: `1px solid ${c.text}` },
  modalNote: { fontSize: "9px", color: c.textDim, fontStyle: "italic", marginTop: "12px", textAlign: "center" },
  sectionCardAlert: { border: `1px solid ${c.rose}`, boxShadow: "0 0 0 3px rgba(251,113,133,0.15)" },
  outputCanvas: { flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", backgroundColor: c.bg, overflow: "hidden" },
  canvasControlBar: { display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: "10px", padding: "12px 18px", borderBottom: `1px solid ${c.border}`, backgroundColor: c.bgElevated, flexShrink: 0 },
  canvasTitleGroup: { display: "flex", flexDirection: "column", gap: "2px", flex: "1 1 200px" },
  canvasTitle: { fontSize: "1rem", fontWeight: "700", fontFamily: fd, color: c.text, margin: 0, letterSpacing: "-0.02em" },
  canvasSubtitle: { fontSize: "0.75rem", color: c.textDim, lineHeight: 1.5 },
  actionRow: { display: "flex", flexWrap: "wrap", gap: "8px", flex: "1 1 280px", justifyContent: "flex-end" },
  actionButton: { border: "1px solid transparent", padding: "9px 16px", borderRadius: r.sm, fontSize: "0.8125rem", fontWeight: "600", cursor: "pointer", fontFamily: "inherit", letterSpacing: "-0.01em" },
  startButton: { backgroundImage: g.live, color: "#fff", boxShadow: "0 4px 14px -6px rgba(52,211,153,0.5)" },
  stopButton: { backgroundImage: g.stop, color: "#fff", boxShadow: "0 4px 14px -6px rgba(251,113,133,0.5)" },
  popOutButton: { backgroundColor: c.bgElevated, color: c.textMuted, border: `1px solid ${c.border}` },
  canvasViewportContainer: { flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: "12px 16px", overflow: "hidden" },
  outputColumn: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "8px", width: "100%", maxWidth: "100%", maxHeight: "100%", minHeight: 0 },
  timerBadgeRow: { display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "center" },
  timerBadgeOutside: { backgroundColor: c.surface, border: `1px solid ${c.border}`, borderRadius: r.sm, padding: "4px 12px", fontSize: "11px", fontWeight: "700", color: c.primary, letterSpacing: "0.08em" },
  fixedOutputContainer: { backgroundColor: "#000", borderRadius: r.md, border: `1px solid ${c.border}`, position: "relative", overflow: "hidden", boxShadow: `0 24px 48px -20px rgba(0,0,0,0.8), 0 0 0 1px rgba(129,140,248,0.08)` },
  mirroredVideo: { width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" },
  fittedImage: { width: "100%", height: "100%", objectFit: "contain" },
  canvasOverlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(11, 16, 32, 0.94)" },
  overlayPingWrap: { position: "relative", width: "24px", height: "24px", marginBottom: "16px", display: "flex", alignItems: "center", justifyContent: "center" },
  overlayRadarPing: { position: "absolute", width: "24px", height: "24px", borderRadius: "50%", border: `2px solid ${c.rose}`, animation: "radarPing 1.8s cubic-bezier(0.2,0.6,0.4,1) infinite" },
  overlayPingDot: { position: "absolute", width: "7px", height: "7px", borderRadius: "50%", backgroundColor: c.rose, boxShadow: "0 0 8px 1px rgba(251,113,133,0.7)" },
  overlayText: { fontSize: "0.9375rem", fontWeight: "600", fontFamily: fd, color: c.textMuted, marginBottom: "4px" },
  overlaySubtext: { fontSize: "0.8125rem", color: c.textDim, lineHeight: 1.55, textAlign: "center", maxWidth: "320px", padding: "0 16px" },
};