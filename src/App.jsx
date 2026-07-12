import React, { useState, useRef, useEffect } from "react";
import { createDecartClient, models } from "@decartai/sdk";

// Reads from a .env file (Vite: VITE_DECART_API_KEY=your_key_here).
// NEVER hardcode a real key in source — it ends up in your bundle and git history.
const MY_DECART_KEY = import.meta.env?.VITE_DECART_API_KEY || "dct_skl_EtlrTGntkgytDiuLlqlWkRcIGCZcUfGabuHdpkWMZxzvROXVmHWVQkbBWUivGkxo";

// How long a live transformation session is allowed to run before auto-stopping.
// This is just a UX cap, unrelated to billing.
const SESSION_DURATION_SECONDS = 5 * 60; // 5 minutes

// --- Real credit ledger backend --------------------------------------------
// See /ledger-backend. The browser NEVER decides the balance — it only ever
// displays whatever this server last reported.
const LEDGER_URL = import.meta.env?.VITE_LEDGER_BACKEND_URL || "http://localhost:3002";
const NAIRA_PER_DOLLAR = 2000; // must match ledger-backend/server.js — keep these in sync
const CREDITS_PER_DOLLAR = 100; // must also match ledger-backend/server.js's TIERS
const NAIRA_PER_CREDIT = NAIRA_PER_DOLLAR / CREDITS_PER_DOLLAR; // = ₦20 per credit
const DISPLAY_CREDITS_PER_SECOND = 2; // for UI copy only — the server decides the real rate
const LOW_CREDIT_THRESHOLD = 40; // ~20 seconds left at 2 credits/sec — warn before it runs out
const HEARTBEAT_INTERVAL_MS = 2000; // how often the frontend checks in with the server ledger

const TOP_UP_OPTIONS = [
  { naira: 20000, credits: 1000 },
  { naira: 100000, credits: 5000 },
  { naira: 200000, credits: 10000, popular: true },
  { naira: 1000000, credits: 50000 },
];

// --- WhatsApp contact (shown on the access-token gate) ---------------------
// TODO: replace with your real number, international format, digits only —
// no "+", no leading "0". e.g. a Nigerian 080xxxxxxxx number becomes 23480xxxxxxxx.
const WHATSAPP_NUMBER = "13306717093";
const WHATSAPP_DEFAULT_MESSAGE = "Hi, I need help getting access to InspireTech.";

// --- Voice changer -----------------------------------------------------------
// Converts your actual mic audio into a different voice (same words, same
// timing) via ElevenLabs Speech-to-Speech, proxied through the ledger backend
// so the API key never reaches the browser. Works in rolling chunks, not
// sample-by-sample — there's always at least one chunk's worth of delay,
// since ElevenLabs' Voice Changer converts complete clips, not a continuous
// stream. Shorter chunks = snappier turnaround but slightly choppier/lower-
// context conversion; longer chunks = smoother conversion but more delay.
const VOICE_CHUNK_MS = 800;

// Real-time voice conversion server (voice-rt-server on RunPod) — a
// continuous WebSocket alternative to the ElevenLabs chunk-based pipeline
// above. See /voice-rt-server/README.md for what this actually is and why
// it's architecturally different (no per-chunk delay).
const VOICE_RT_URL = import.meta.env?.VITE_VOICE_RT_URL || "";
const VOICE_RT_FRAME_SAMPLES = 640; // 40ms @ 16kHz — must match voice-rt-server's FRAME_SAMPLES

export default function App() {
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("SYSTEM STANDBY");
  const [selectedFile, setSelectedFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);

  const [bitrate, setBitrate] = useState("Adaptive (4.2 Mbps)");
  const [latency, setLatency] = useState("0 ms");
  const [fps, setFps] = useState(0);

  const [timeRemaining, setTimeRemaining] = useState(SESSION_DURATION_SECONDS);

  const [inferenceWeight, setInferenceWeight] = useState(85);
  const [enhanceMask, setEnhanceMask] = useState(true);
  const [activeModel, setActiveModel] = useState("lucy-realtime-v2.1");

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

  const MODEL_ID_MAP = {
    "lucy-realtime-v2.1": "lucy-2.1",
    "lucy-speed-v1.9": "lucy-1.9",
  };
  const getModelId = () => MODEL_ID_MAP[activeModel] || "lucy-2.1";

  // --- Access token (given to you by the admin — see ledger-backend README) ---
  const [accessToken, setAccessToken] = useState(() => {
    try {
      return window.localStorage.getItem("inspiretech_access_token") || "";
    } catch {
      return "";
    }
  });
  const [tokenInput, setTokenInput] = useState("");
  const [tokenError, setTokenError] = useState("");

  const authHeaders = () => ({ "X-Access-Token": accessToken });

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
  const pipSupported = typeof document !== "undefined" && document.pictureInPictureEnabled;

  const localVideoRef = useRef(null);
  const outputVideoRef = useRef(null);
  const fileInputRef = useRef(null);
  const localStreamRef = useRef(null);
  const realtimeClientRef = useRef(null);
  const fpsIntervalRef = useRef(null);
  const clockTimerRef = useRef(null); // the local 5-min UX countdown (not billing)
  const heartbeatTimerRef = useRef(null); // the real billing tick, talking to the server
  const billingSessionIdRef = useRef(null);
  const creditSectionRef = useRef(null);
  const startInProgressRef = useRef(false);

  // --- Voice changer refs ---
  const voiceChangerActiveRef = useRef(false);
  const voiceRecorderRef = useRef(null);
  const audioContextRef = useRef(null);
  const voiceDestinationRef = useRef(null);
  const voicePlaybackQueueTimeRef = useRef(0);
  const analyserRef = useRef(null);
  const voiceLevelIntervalRef = useRef(null);
  const chunkHadSpeechRef = useRef(false);
  const noiseFloorRef = useRef(0.005); // adaptive ambient-noise estimate, updated continuously while quiet
  const rtcSocketRef = useRef(null);
  const rtcWorkletNodeRef = useRef(null);
  const rtcMicSourceRef = useRef(null);

  // --- Fetch the real balance on load, and handle returning from Paystack Checkout ---
  useEffect(() => {
    if (!accessToken) return;
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
  }, [accessToken]);

  // Idle revocation check: if an admin revokes access while someone is just
  // sitting on the page (not actively mid-transformation, so the heartbeat
  // below isn't running), this is what catches it and logs them out without
  // needing to wait for their next action.
  useEffect(() => {
    if (!accessToken) return;
    const interval = setInterval(() => {
      refreshBalance();
    }, 25000);
    return () => clearInterval(interval);
  }, [accessToken]);

  useEffect(() => {
    if (showAddCredits && creditSectionRef.current) {
      creditSectionRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [showAddCredits]);

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

  // Pops the OUTPUT MONITOR video into its own floating, chrome-free window
  // via the browser's native Picture-in-Picture — this is the one built-in
  // way to move a live MediaStream into its own window without having to
  // re-establish the WebRTC connection there, since a plain window.open()
  // popup can't share a live stream with the tab that created it. In OBS,
  // add a Window Capture source pointed at this floating PiP window and
  // there's nothing to crop — it contains only the video.
  const handlePopOutVideo = async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (outputVideoRef.current) {
        await outputVideoRef.current.requestPictureInPicture();
      }
    } catch (err) {
      console.error("Picture-in-Picture failed:", err);
      setStatus(`POP-OUT FAILED: ${err.message}`);
    }
  };

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
    if (!VOICE_RT_URL) {
      setRtcLoadError("VITE_VOICE_RT_URL is not set in the frontend's .env — point it at your voice-rt-server deployment.");
      setRtcVoicesLoading(false);
      return;
    }
    setRtcVoicesLoading(true);
    (async () => {
      try {
        const ticketRes = await ledgerFetchTicket();
        if (!ticketRes) return; // handleTokenRejected or an error already surfaced
        const res = await fetch(`${VOICE_RT_URL}/voices?ticket=${encodeURIComponent(ticketRes.ticket)}`);
        const data = await res.json().catch(() => ({}));
        if (res.ok && Array.isArray(data.voices)) {
          setRtcVoices(data.voices);
          if (data.voices.length === 0) {
            setRtcLoadError("No voice models found on voice-rt-server — upload some to its /models volume.");
          } else {
            setRtcLoadError("");
            if (!rtcSelectedVoiceId) setRtcSelectedVoiceId(data.voices[0].voice_id);
          }
        } else {
          setRtcLoadError(data.error || `Could not reach voice-rt-server (status ${res.status})`);
        }
      } catch (err) {
        console.error("Could not load real-time voice list:", err);
        setRtcLoadError("Could not reach voice-rt-server — is it deployed and running?");
      } finally {
        setRtcVoicesLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, voiceEngine]);

  // Single place that handles "the server no longer accepts this token" —
  // covers both an invalid token (401) and a revoked one (403). Always safe
  // to call: stopTransformation() itself no-ops if nothing is running.
  const handleTokenRejected = (message) => {
    stopTransformation();
    clearAccessToken();
    setTokenError(message);
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
      return data; // { ticket, expiresInSeconds }
    } catch (err) {
      console.error("Failed to fetch RTC ticket:", err);
      setRtcLoadError("Could not reach the ledger backend for a connection ticket");
      return null;
    }
  };

  const refreshBalance = async () => {
    try {
      const res = await fetch(`${LEDGER_URL}/api/credits`, { headers: authHeaders() });
      if (res.status === 401) {
        handleTokenRejected("That access token was rejected by the server. Please re-enter it.");
        return;
      }
      if (res.status === 403) {
        handleTokenRejected("Your access has been revoked. If you think this is a mistake, message us on WhatsApp below.");
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
  // TUNING, if it's still off after this change:
  //   - Still triggering on background noise? Raise VOICE_ACTIVITY_MULTIPLIER
  //     (e.g. 4 or 5) so it demands a bigger jump above the ambient floor.
  //   - Missing soft speech? Lower VOICE_ACTIVITY_MULTIPLIER (e.g. 2), or
  //     lower VOICE_ACTIVITY_MIN_THRESHOLD if your room is extremely quiet.
  const VOICE_ACTIVITY_MULTIPLIER = 3; // how many times louder than "quiet" counts as speech
  const VOICE_ACTIVITY_MIN_THRESHOLD = 0.012; // absolute floor, for near-silent rooms
  const VOICE_ACTIVITY_MIN_CONSECUTIVE = 2; // consecutive 100ms samples needed — filters clicks/taps
  const VOICE_LEVEL_CHECK_MS = 100;

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
    if (!res.ok) throw new Error(`Voice conversion failed: ${res.status}`);

    const arrayBuffer = await res.arrayBuffer();
    const audioCtx = audioContextRef.current;
    const destination = voiceDestinationRef.current;
    if (!audioCtx || !destination) return; // pipeline was stopped while this was in flight

    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(destination);

    // Schedule sequentially so chunks play back-to-back instead of overlapping
    // or leaving gaps if one comes back slower than another.
    const now = audioCtx.currentTime;
    const startAt = Math.max(now, voicePlaybackQueueTimeRef.current);
    source.start(startAt);
    voicePlaybackQueueTimeRef.current = startAt + audioBuffer.duration;
  };

  // Starts the continuous record → convert → schedule loop, and returns the
  // synthetic converted-voice MediaStream to use instead of the raw mic.
  const startVoiceChangerCapture = (micStream) => {
    const micTrack = micStream.getAudioTracks()[0];
    if (!micTrack) return null;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtx();
    const destination = audioCtx.createMediaStreamDestination();
    audioContextRef.current = audioCtx;
    voiceDestinationRef.current = destination;
    voicePlaybackQueueTimeRef.current = audioCtx.currentTime;
    voiceChangerActiveRef.current = true;
    noiseFloorRef.current = 0.005; // reset to a sane starting estimate each session

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
    const timeDomainData = new Float32Array(analyser.fftSize);
    analyserRef.current = analyser;

    chunkHadSpeechRef.current = false;
    let consecutiveLoudSamples = 0;

    voiceLevelIntervalRef.current = setInterval(() => {
      analyser.getFloatTimeDomainData(timeDomainData);
      let sumSquares = 0;
      for (let i = 0; i < timeDomainData.length; i++) sumSquares += timeDomainData[i] * timeDomainData[i];
      const rms = Math.sqrt(sumSquares / timeDomainData.length);

      // A real speech threshold: clearly above whatever "quiet" has recently
      // measured as, with a small absolute floor so a near-silent room
      // (noise floor ~0) doesn't end up with a near-zero threshold.
      const dynamicThreshold = Math.max(noiseFloorRef.current * VOICE_ACTIVITY_MULTIPLIER, VOICE_ACTIVITY_MIN_THRESHOLD);

      if (rms > dynamicThreshold) {
        consecutiveLoudSamples += 1;
        if (consecutiveLoudSamples >= VOICE_ACTIVITY_MIN_CONSECUTIVE) {
          chunkHadSpeechRef.current = true;
        }
      } else {
        consecutiveLoudSamples = 0;
        // Only adapt the noise floor during quiet moments, so a burst of
        // actual speech doesn't drag the "quiet" baseline upward with it.
        noiseFloorRef.current = noiseFloorRef.current * 0.95 + rms * 0.05;
      }
    }, VOICE_LEVEL_CHECK_MS);

    const recordCycle = () => {
      if (!voiceChangerActiveRef.current) return;
      chunkHadSpeechRef.current = false; // reset the flag for this chunk's window
      const recorder = new MediaRecorder(new MediaStream([micTrack]), { mimeType: "audio/webm" });
      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: "audio/webm" });
        // Only send this clip on if the live monitor actually caught real
        // speech energy at some point during it — true silence never
        // reaches ElevenLabs at all.
        if (chunkHadSpeechRef.current) {
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
    return destination.stream;
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
    if (!micTrack || !VOICE_RT_URL || !rtcSelectedVoiceId) return null;

    const ticketRes = await ledgerFetchTicket();
    if (!ticketRes) return null;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtx();
    const destination = audioCtx.createMediaStreamDestination();
    audioContextRef.current = audioCtx;
    voiceDestinationRef.current = destination;
    voicePlaybackQueueTimeRef.current = audioCtx.currentTime;

    try {
      await audioCtx.audioWorklet.addModule("/pcm-capture-worklet.js");
    } catch (err) {
      console.error("Failed to load capture worklet:", err);
      setStatus("REAL-TIME VOICE UNAVAILABLE — WORKLET FAILED TO LOAD");
      return null;
    }

    const wsProtocol = VOICE_RT_URL.startsWith("https") ? "wss" : "ws";
    const wsUrl = `${VOICE_RT_URL.replace(/^https?/, wsProtocol)}/convert?ticket=${encodeURIComponent(ticketRes.ticket)}&voice_id=${encodeURIComponent(rtcSelectedVoiceId)}`;
    const socket = new WebSocket(wsUrl);
    socket.binaryType = "arraybuffer";
    rtcSocketRef.current = socket;

    socket.onmessage = (event) => {
      const audioCtxNow = audioContextRef.current;
      const destinationNow = voiceDestinationRef.current;
      if (!audioCtxNow || !destinationNow) return;
      if (typeof event.data === "string") {
        // voice-rt-server sends JSON text only for error messages (see server.py)
        console.error("voice-rt-server error:", event.data);
        return;
      }
      const int16 = new Int16Array(event.data);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
      // Web Audio resamples automatically if this buffer's rate differs from
      // the context's — no manual upsampling needed for playback.
      const audioBuffer = audioCtxNow.createBuffer(1, float32.length, 16000);
      audioBuffer.copyToChannel(float32, 0);
      const source = audioCtxNow.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(destinationNow);
      const now = audioCtxNow.currentTime;
      const startAt = Math.max(now, voicePlaybackQueueTimeRef.current);
      source.start(startAt);
      voicePlaybackQueueTimeRef.current = startAt + audioBuffer.duration;
    };

    socket.onerror = (err) => {
      console.error("voice-rt-server WebSocket error:", err);
      setStatus("REAL-TIME VOICE CONNECTION ERROR");
    };

    const micSource = audioCtx.createMediaStreamSource(new MediaStream([micTrack]));
    rtcMicSourceRef.current = micSource;
    const workletNode = new AudioWorkletNode(audioCtx, "pcm-capture-processor", {
      processorOptions: { targetSampleRate: 16000, frameSamples: VOICE_RT_FRAME_SAMPLES },
    });
    rtcWorkletNodeRef.current = workletNode;

    workletNode.port.onmessage = (event) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(event.data); // ArrayBuffer of Int16 PCM samples
      }
    };

    // The worklet needs to be part of the active render graph to keep
    // processing — route it to destination through a silent (zero-gain)
    // node so it never actually plays back locally.
    const silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;
    micSource.connect(workletNode);
    workletNode.connect(silentGain);
    silentGain.connect(audioCtx.destination);

    return destination.stream;
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
  };


  const startClockTimer = () => {
    clearClockTimer();
    setTimeRemaining(SESSION_DURATION_SECONDS);
    clockTimerRef.current = setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev <= 1) {
          clearClockTimer();
          stopTransformation();
          setStatus("SESSION TIMEOUT: 5-MINUTE LIMIT REACHED");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const clearClockTimer = () => {
    if (clockTimerRef.current) {
      clearInterval(clockTimerRef.current);
      clockTimerRef.current = null;
    }
  };

  // The REAL billing loop — every tick asks the server "how much do I have
  // left now", and the server is the one doing the math and the deduction.
  const startHeartbeat = (sessionId) => {
    clearHeartbeat();
    setSessionCreditsUsed(0);
    const startedAtCredits = credits;

    heartbeatTimerRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${LEDGER_URL}/api/sessions/${sessionId}/heartbeat`, {
          method: "POST",
          headers: authHeaders(),
        });
        if (res.status === 401) {
          handleTokenRejected("Your session expired — please re-enter your access token.");
          return;
        }
        if (res.status === 403) {
          handleTokenRejected("Your access has been revoked. If you think this is a mistake, message us on WhatsApp below.");
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
        // Network hiccup — don't kill the session over one missed beat,
        // but if the backend is genuinely down the next beats will keep failing.
      }
    }, HEARTBEAT_INTERVAL_MS);
  };

  const clearHeartbeat = () => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  };

  const formatTime = (totalSeconds) => {
    const m = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
    const s = (totalSeconds % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  const formatNaira = (creditAmount) => `₦${Math.round(creditAmount * NAIRA_PER_CREDIT).toLocaleString()}`;

  const startCamera = async () => {
    try {
      setStatus("PROVISIONING MEDIA INPUTS...");
      const model = models.realtime(getModelId());

      const stream = await navigator.mediaDevices.getUserMedia({
        // Explicit rather than relying on browser defaults — these actively
        // reduce steady background noise (fan/AC hum, hiss) at the source,
        // before it ever reaches the voice-activity gate below.
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        // `ideal` (not a bare number) — a bare number can be treated as a
        // hard requirement, which some external cameras satisfy by digitally
        // cropping/zooming rather than reporting their natural wider field
        // of view. `ideal` lets the camera pick its closest natural mode instead.
        video: {
          // Not using model.fps here on purpose — it can return a non-finite
          // value (e.g. Infinity) for some models, which `|| 24` doesn't
          // catch (only falsy values like 0/undefined/NaN trigger that
          // fallback — Infinity is truthy and sails right through), and the
          // browser then rejects the constraint outright.
          frameRate: { ideal: 24 },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
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

    // Ask the server for permission to start — it's the one that knows the
    // real balance, not this client.
    let sessionId;
    try {
      const res = await fetch(`${LEDGER_URL}/api/sessions/start`, { method: "POST", headers: authHeaders() });
      const data = await res.json();
      if (res.status === 401) {
        handleTokenRejected("Your access token was rejected. Please re-enter it.");
        startInProgressRef.current = false;
        return;
      }
      if (res.status === 403) {
        handleTokenRejected("Your access has been revoked. If you think this is a mistake, message us on WhatsApp below.");
        startInProgressRef.current = false;
        return;
      }
      if (!res.ok) {
        setCredits(data.credits ?? 0);
        setStatus("OUT OF CREDITS — ADD MORE TO CONTINUE");
        setShowAddCredits(true);
        startInProgressRef.current = false;
        return;
      }
      sessionId = data.sessionId;
      setCredits(data.credits);
    } catch (err) {
      console.error("Failed to start billing session:", err);
      setStatus("LEDGER BACKEND UNREACHABLE — CHECK IT'S RUNNING");
      setLedgerUnreachable(true);
      startInProgressRef.current = false;
      return;
    }

    billingSessionIdRef.current = sessionId;
    setIsRunning(true);
    // From here on, isRunning (true) covers the double-click guard duty via
    // the Start button's disabled state — safe to release the ref lock.
    startInProgressRef.current = false;
    setStatus("HANDSHAKING WITH DECART WEBRTC CLUSTER...");

    // If the voice changer is on, swap the raw mic track for a synthetic one
    // carrying the converted voice — Decart only ever sees/forwards this,
    // never the original audio.
    let streamForDecart = localStreamRef.current;
    if (voiceChangerEnabled && selectedVoiceId) {
      const convertedAudioStream = startVoiceChangerCapture(localStreamRef.current);
      if (convertedAudioStream) {
        const videoTrack = localStreamRef.current.getVideoTracks()[0];
        const convertedAudioTrack = convertedAudioStream.getAudioTracks()[0];
        streamForDecart = new MediaStream([videoTrack, convertedAudioTrack].filter(Boolean));
      } else {
        setStatus("VOICE CHANGER UNAVAILABLE — CONTINUING WITH ORIGINAL AUDIO");
      }
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
            mirror: false,
            onRemoteStream: (remoteStream) => {
              if (outputVideoRef.current) outputVideoRef.current.srcObject = remoteStream;
            },
            onError: (err) => {
              console.error("Decart Session Error:", err);
              setStatus(`CRITICAL FAULT: ${err.message}`);
              setIsRunning(false);
              clearClockTimer();
              clearHeartbeat();
              stopVoiceChangerCapture();
            },
            onDisconnect: () => {
              setStatus("PIPELINE TERMINATED");
              setIsRunning(false);
              clearClockTimer();
              clearHeartbeat();
              stopVoiceChangerCapture();
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
          setStatus("COMPUTE LINK ONLINE // REALTIME TRANSFORMATION TERMINAL");
          startClockTimer();
          startHeartbeat(sessionId);
        } catch (connectErr) {
          console.error(connectErr);
          setStatus(`HANDSHAKE REJECTED: ${connectErr.message}`);
          setIsRunning(false);
          stopVoiceChangerCapture();
          endBillingSession(sessionId);
        }
      };
    } catch (err) {
      console.error("Failed to initialize Decart client:", err);
      setStatus(`CLIENT INIT FAILED: ${err.message || "check VITE_DECART_API_KEY is set"}`);
      setIsRunning(false);
      stopVoiceChangerCapture();
      endBillingSession(sessionId);
    }
  };

  const endBillingSession = async (sessionId) => {
    if (!sessionId) return;
    try {
      const res = await fetch(`${LEDGER_URL}/api/sessions/${sessionId}/end`, { method: "POST", headers: authHeaders() });
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
    stopVoiceChangerCapture();

    const sessionId = billingSessionIdRef.current;
    billingSessionIdRef.current = null;
    endBillingSession(sessionId);

    setIsRunning(false);
    setStatus((prev) => (prev.startsWith("OUT OF CREDITS") ? prev : "PIPELINE DISCONNECTED"));
    setTimeRemaining(SESSION_DURATION_SECONDS);
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
        handleTokenRejected("Your access has been revoked. If you think this is a mistake, message us on WhatsApp below.");
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

  // No access token yet — show a simple entry gate instead of the app.
  // Admin generates tokens via the /admin.html page on the ledger backend.
  if (!accessToken) {
    return (
      <div style={styles.gateContainer} className="itc-app">
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
          html, body, #root { margin: 0; padding: 0; width: 100%; height: 100%; }
          *, *::before, *::after { box-sizing: border-box; }
          .itc-whatsapp-link { color: #34d399; text-decoration: none; transition: opacity 0.15s ease; }
          .itc-whatsapp-link:hover { opacity: 0.8; text-decoration: underline; }
          @media (max-width: 480px) {
            .itc-gate-card { padding: 24px 20px !important; }
          }
        `}</style>
        <div style={styles.gateCard} className="itc-gate-card">
          <div style={styles.gateBrand}>🛸 InspireTech</div>
          <h1 style={styles.gateTitle}>Enter your access token</h1>
          <p style={styles.gateSubtitle}>
            You should have received this from whoever gave you access. Paste it below to continue.
          </p>
          <input
            type="text"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="e.g. 3f2a9c1e-4b6d-4a8e-9c2f-1d7e5a6b8c90"
            style={styles.gateInput}
            className="itc-input"
            onKeyDown={(e) => {
              if (e.key === "Enter" && tokenInput.trim()) {
                setTokenError("");
                saveAccessToken(tokenInput.trim());
              }
            }}
          />
          {tokenError && <div style={styles.gateError}>{tokenError}</div>}
          <button
            style={styles.gateButton}
            className="itc-btn itc-btn-primary"
            disabled={!tokenInput.trim()}
            onClick={() => {
              setTokenError("");
              saveAccessToken(tokenInput.trim());
            }}
          >
            Continue
          </button>
          <a
            href={`https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(WHATSAPP_DEFAULT_MESSAGE)}`}
            target="_blank"
            rel="noopener noreferrer"
            style={styles.gateWhatsapp}
            className="itc-whatsapp-link"
          >
            💬 Need help or don't have a token? Message us on WhatsApp
          </a>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.appContainer} className="itc-app">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        html, body, #root { margin: 0; padding: 0; width: 100%; height: 100%; }
        *, *::before, *::after { box-sizing: border-box; }
        :focus-visible { outline: 2px solid #5b8def; outline-offset: 2px; border-radius: 4px; }
        .itc-btn { position: relative; transition: transform 0.18s cubic-bezier(0.4,0,0.2,1), box-shadow 0.18s cubic-bezier(0.4,0,0.2,1), filter 0.18s cubic-bezier(0.4,0,0.2,1), border-color 0.18s cubic-bezier(0.4,0,0.2,1), background-color 0.18s cubic-bezier(0.4,0,0.2,1); }
        .itc-btn:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.08); }
        .itc-btn:active:not(:disabled) { transform: translateY(0); filter: brightness(0.94); }
        .itc-btn:disabled { cursor: not-allowed; }
        .itc-btn-primary:hover:not(:disabled) { box-shadow: 0 10px 24px -8px rgba(91,141,239,0.55), 0 0 0 1px rgba(91,141,239,0.35); }
        .itc-btn-secondary:hover:not(:disabled) { border-color: #3a4356 !important; background-color: #1a2030 !important; color: #e6e9ef !important; box-shadow: 0 8px 18px -8px rgba(0,0,0,0.55); }
        .itc-btn-start:hover:not(:disabled) { box-shadow: 0 10px 26px -8px rgba(34,197,94,0.5); }
        .itc-btn-stop:hover:not(:disabled) { box-shadow: 0 10px 26px -8px rgba(240,87,106,0.5); }
        .itc-btn-topup:hover:not(:disabled) { box-shadow: 0 10px 24px -8px rgba(91,141,239,0.55); border-color: #5b8def !important; }
        .itc-select { transition: border-color 0.18s ease, box-shadow 0.18s ease; cursor: pointer; }
        .itc-select:hover, .itc-select:focus { border-color: #5b8def !important; box-shadow: 0 0 0 3px rgba(91,141,239,0.14); outline: none; }
        .itc-range { cursor: pointer; transition: filter 0.18s ease; }
        .itc-range:hover { filter: brightness(1.15); }
        .itc-range:disabled { cursor: not-allowed; opacity: 0.45; filter: none; }
        .itc-checkbox { cursor: pointer; transition: transform 0.15s cubic-bezier(0.4,0,0.2,1); }
        .itc-checkbox:hover { transform: scale(1.12); }
        .itc-checkbox:disabled { cursor: not-allowed; opacity: 0.45; transform: none; }
        .itc-select:disabled { cursor: not-allowed; opacity: 0.45; }
        .itc-card { transition: border-color 0.2s ease, box-shadow 0.2s ease; }
        .itc-card:hover { border-color: #2a3348; box-shadow: 0 10px 28px -18px rgba(0,0,0,0.8); }
        @keyframes radarPing { 0% { transform: scale(0.55); opacity: 0.85; } 70% { transform: scale(1.6); opacity: 0; } 100% { transform: scale(1.6); opacity: 0; } }
        @keyframes creditPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: #05070c; }
        ::-webkit-scrollbar-thumb { background: #1e2537; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #2c3550; }

        /* ============================================================
           RESPONSIVE / MOBILE LAYOUT
           ============================================================ */
        @media (max-width: 900px) {
          html, body, #root { height: auto; min-height: 100%; }
          .itc-app { height: auto !important; min-height: 100dvh !important; overflow: visible !important; }
          .itc-main-workspace { flex-direction: column !important; overflow: visible !important; }
          .itc-sidebar { width: 100% !important; max-height: none !important; border-right: none !important; border-bottom: 1px solid #1a2030 !important; overflow-y: visible !important; }
          .itc-output-canvas { overflow: visible !important; }
          .itc-canvas-control-bar { flex-direction: column !important; align-items: stretch !important; gap: 12px !important; }
          .itc-action-row { width: 100% !important; }
          .itc-action-row .itc-btn { flex: 1 1 0 !important; padding: 14px 12px !important; font-size: 13px !important; }
          .itc-canvas-viewport { padding: 12px !important; }

          /* Output monitor: on mobile this becomes a fixed half-screen-height
             box instead of scaling by the desktop 860:520 aspect ratio, which
             would otherwise leave it quite short on a narrow phone. */
          .itc-fixed-output { width: 100% !important; max-width: 100% !important; aspect-ratio: unset !important; height: 50vh !important; height: 50dvh !important; }

          /* Local camera preview: bigger on mobile so it's actually usable
             for framing yourself, instead of the small desktop sidebar thumbnail. */
          .itc-local-video-wrapper { aspect-ratio: unset !important; height: 42vh !important; height: 42dvh !important; }

          .itc-credit-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .itc-status-ribbon { width: 100% !important; }
          .itc-top-header { padding: 10px 14px !important; }
        }

        @media (max-width: 480px) {
          .itc-canvas-title { font-size: 12px !important; }
          .itc-canvas-subtitle { font-size: 10px !important; }
          .itc-status-pill, .itc-status-pill-last { font-size: 10px !important; padding: 4px 8px !important; }
          .itc-section-card { padding: 12px !important; }
          .itc-action-row { flex-direction: column !important; }
          .itc-range { width: 100% !important; }
          .itc-param-slider-group { width: 60% !important; }
          .itc-checkbox { width: 20px !important; height: 20px !important; }
          .itc-btn, select.itc-select { min-height: 44px !important; }
          .itc-local-video-wrapper { height: 38vh !important; height: 38dvh !important; }
          .itc-fixed-output { height: 46vh !important; height: 46dvh !important; }
        }
      `}</style>

      <header style={styles.topHeader} className="itc-top-header">
        <div style={styles.brandingGroup}>
          <span style={styles.brandIcon}>🛸</span>
          <div style={styles.logoText}>
            InspireTech<span style={styles.logoVersion}>v2.8</span>
          </div>
          <button
            style={styles.switchTokenLink}
            onClick={() => {
              if (isRunning) stopTransformation();
              clearAccessToken();
            }}
          >
            switch token
          </button>
        </div>

        <div style={styles.systemStatusRibbon} className="itc-status-ribbon">
          <div style={styles.statusPill} className="itc-status-pill">
            <span style={styles.metaLabel}>ENGINE_STATUS:</span>
            <span style={{...styles.metaValue, color: isRunning ? "#22c55e" : "#f5a524"}}>{status}</span>
          </div>
          <div style={styles.statusPill} className="itc-status-pill">
            <span style={styles.metaLabel}>FPS:</span>
            <span style={styles.metaValue}>{fps || "--"}</span>
          </div>
          <div style={styles.statusPill} className="itc-status-pill">
            <span style={styles.metaLabel}>LATENCY:</span>
            <span style={styles.metaValue}>{latency}</span>
          </div>
          <div style={styles.statusPill} className="itc-status-pill">
            <span style={styles.metaLabel}>SESSION_TIME:</span>
            <span style={{...styles.metaValue, color: isRunning && timeRemaining <= 30 ? "#f0576a" : "#5b8def"}}>
              {isRunning ? formatTime(timeRemaining) : "05:00"}
            </span>
          </div>
          <div style={styles.statusPillLast} className="itc-status-pill-last">
            <span style={styles.metaLabel}>CREDITS:</span>
            <span style={{...styles.metaValue, color: isLowCredit ? "#f0576a" : "#5b8def", animation: isLowCredit && isRunning ? "creditPulse 1s infinite" : "none"}}>
              {creditsLoaded ? `${credits} ` : "…"}
              {creditsLoaded && <span style={styles.creditsDollar}>({formatNaira(credits)})</span>}
            </span>
          </div>
        </div>
      </header>

      <div style={styles.mainWorkspace} className="itc-main-workspace">
        <aside style={styles.controlSidebar} className="itc-sidebar">

          <div style={styles.sectionCard} className="itc-card itc-section-card">
            <div style={styles.cardHeaderStrip}>
              <span style={styles.cardHeaderIcon}>⚙️</span> I/O PERIPHERAL SELECTION
            </div>
            <div style={styles.buttonStack}>
              <button style={styles.primaryButton} className="itc-btn itc-btn-primary" onClick={startCamera}>
                Start Hardware Camera
              </button>
              <button style={styles.secondaryButton} className="itc-btn itc-btn-secondary" onClick={() => fileInputRef.current?.click()}>
                Upload Reference Image
              </button>
              <input type="file" ref={fileInputRef} accept="image/*" style={{ display: "none" }} onChange={(e) => handleFileChange(e.target.files?.[0])} />
            </div>
          </div>

          {/* --- Real credit meter card --- */}
          <div style={styles.sectionCard} className="itc-card itc-section-card">
            <div style={styles.cardHeaderStrip}>
              <span style={styles.cardHeaderIcon}>💳</span> CREDIT BALANCE
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
                  <div style={{...styles.creditBarFill, width: `${creditPercent}%`, backgroundColor: isLowCredit ? "#f0576a" : "#5b8def"}} />
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
            <div style={styles.cardHeaderStrip}>
              <span style={styles.cardHeaderIcon}>🖼️</span> REFERENCE IMAGE
            </div>
            <div style={styles.imageBox}>
              {imagePreview ? (
                <img src={imagePreview} alt="Target Reference" style={styles.fittedImage} />
              ) : (
                <div style={styles.emptyBoxPlaceholder}>NO REFERENCE IMAGE UPLOADED</div>
              )}
            </div>
          </div>

          <div style={styles.sectionCard} className="itc-card itc-section-card">
            <div style={styles.cardHeaderStrip}>
              <span style={styles.cardHeaderIcon}>🎙️</span> VOICE CHANGER
            </div>
            <div style={styles.parameterRow}>
              <label style={styles.paramLabel}>ENABLE VOICE CHANGER</label>
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
              <div style={styles.voiceSelectGroup}>
                <label style={styles.paramLabel}>TARGET VOICE</label>
                <select
                  value={selectedVoiceId}
                  onChange={(e) => setSelectedVoiceId(e.target.value)}
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
              </div>
            )}
            {voiceLoadError && <div style={styles.ledgerErrorNote}>{voiceLoadError}</div>}
            <div style={styles.paramsLockedNote}>
              {isRunning
                ? "Locked while live — changes apply on next deploy"
                : `Converts your voice in ~${VOICE_CHUNK_MS / 1000}s rolling clips — short delay per phrase, not instant.`}
            </div>
          </div>

          <div style={styles.sectionCard} className="itc-card itc-section-card">
            <div style={styles.cardHeaderStrip}>
              <span style={styles.cardHeaderIcon}>👁️</span> LOCAL CAPTURE INTERCEPT
            </div>
            <div style={styles.sidebarVideoWrapper} className="itc-local-video-wrapper">
              <video ref={localVideoRef} autoPlay playsInline muted style={styles.mirroredVideo} />
            </div>
          </div>

          <div ref={creditSectionRef} style={{...styles.sectionCard, ...(showAddCredits ? styles.sectionCardAlert : {}), flex: 1}} className="itc-card itc-section-card">
            <div style={styles.cardHeaderStrip}>
              <span style={styles.cardHeaderIcon}>💳</span> BUY MORE CREDITS
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
            <div style={styles.canvasTitleGroup}>
              <h2 style={styles.canvasTitle} className="itc-canvas-title">OUTPUT MONITOR</h2>
              <span style={styles.canvasSubtitle} className="itc-canvas-subtitle">Matrix Field Resolution: 1280x720, scaled to fit viewport</span>
            </div>
            <div style={styles.actionRow} className="itc-action-row">
              <button
                style={{...styles.actionButton, ...styles.startButton, opacity: (isRunning || !selectedFile || credits <= 0 || ledgerUnreachable) ? 0.5 : 1}}
                className="itc-btn itc-btn-start"
                onClick={startTransformation}
                disabled={isRunning || !selectedFile || credits <= 0 || ledgerUnreachable}
              >
                ⚡ START TRANSFORMATION
              </button>
              <button
                style={{...styles.actionButton, ...styles.stopButton, opacity: !isRunning ? 0.5 : 1}}
                className="itc-btn itc-btn-stop"
                onClick={stopTransformation}
                disabled={!isRunning}
              >
                🛑 STOP TRANSFORMATION
              </button>
              <button
                style={{...styles.actionButton, ...styles.popOutButton, opacity: !pipSupported ? 0.5 : 1}}
                className="itc-btn itc-btn-secondary"
                onClick={handlePopOutVideo}
                disabled={!pipSupported}
                title={pipSupported ? "Pop the output video into its own floating window — capture that window in OBS/your calling app" : "Picture-in-Picture isn't supported in this browser — try Chrome or Edge"}
              >
                {isPoppedOut ? "↩ Return to App" : "🗗 Pop Out for OBS"}
              </button>
            </div>
          </div>

          <div style={styles.canvasViewportContainer} className="itc-canvas-viewport">
            <div style={styles.outputColumn}>
              {isRunning && (
                <div style={styles.timerBadgeRow}>
                  <div style={styles.timerBadgeOutside}>{formatTime(timeRemaining)}</div>
                  <div style={{...styles.timerBadgeOutside, color: isLowCredit ? "#f0576a" : "#5b8def"}}>
                    {credits} credits left
                  </div>
                </div>
              )}
              <div style={styles.fixedOutputContainer} className="itc-fixed-output">
                <video ref={outputVideoRef} autoPlay playsInline style={styles.mirroredVideo} />
                {!isRunning && (
                  <div style={styles.canvasOverlay}>
                    <div style={styles.overlayPingWrap}>
                      <div style={styles.overlayRadarPing} />
                      <div style={styles.overlayPingDot} />
                    </div>
                    <div style={styles.overlayText}>
                      {credits <= 0 && creditsLoaded ? "OUT OF CREDITS" : "PIPELINE DISPATCH DISCONNECTED"}
                    </div>
                    <div style={styles.overlaySubtext}>
                      {credits <= 0 && creditsLoaded ? "Add credits from the sidebar to redeploy." : "Awaiting initial backend WebRTC link execution sequence..."}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

const styles = {
  gateContainer: { backgroundColor: "#090b11", height: "100%", width: "100%", minHeight: "100vh", color: "#dde1e8", fontFamily: '"JetBrains Mono", Consolas, "Courier New", Monaco, monospace', display: "flex", alignItems: "center", justifyContent: "center", padding: "20px", boxSizing: "border-box" },
  gateCard: { backgroundColor: "#0d111c", border: "1px solid #1a2030", borderRadius: "12px", padding: "32px", maxWidth: "420px", width: "100%", boxShadow: "0 30px 60px -20px rgba(0,0,0,0.8)" },
  gateBrand: { fontSize: "14px", fontWeight: "800", fontFamily: '"Inter", system-ui, sans-serif', color: "#5b8def", marginBottom: "18px" },
  gateTitle: { fontSize: "18px", fontWeight: "800", fontFamily: '"Inter", system-ui, sans-serif', color: "#f4f6fa", margin: "0 0 8px" },
  gateSubtitle: { fontSize: "12px", color: "#6b7385", margin: "0 0 20px", lineHeight: "1.5" },
  gateInput: { width: "100%", backgroundColor: "#05070c", color: "#e6e9ef", border: "1px solid #262e42", borderRadius: "6px", padding: "10px 12px", fontFamily: "inherit", fontSize: "12px", marginBottom: "8px" },
  gateError: { fontSize: "11px", color: "#f0576a", marginBottom: "12px" },
  gateButton: { width: "100%", backgroundColor: "#3f6fdb", backgroundImage: "linear-gradient(135deg, #6d97f2 0%, #3a63c7 100%)", color: "#fff", border: "1px solid rgba(109,151,242,0.4)", padding: "10px 14px", borderRadius: "6px", fontSize: "12px", fontWeight: "700", cursor: "pointer", fontFamily: "inherit", marginTop: "8px" },
  gateWhatsapp: { display: "block", textAlign: "center", fontSize: "11px", marginTop: "18px", fontWeight: "600" },
  appContainer: { backgroundColor: "#090b11", height: "100%", width: "100%", color: "#dde1e8", fontFamily: '"JetBrains Mono", Consolas, "Courier New", Monaco, monospace', display: "flex", flexDirection: "column", overflow: "hidden", margin: 0, padding: 0, boxSizing: "border-box" },
  topHeader: { display: "flex", flexWrap: "wrap", rowGap: "8px", justifyContent: "space-between", alignItems: "center", padding: "8px 24px", minHeight: "56px", borderBottom: "1px solid #1a2030", backgroundColor: "#0d101a", backgroundImage: "linear-gradient(180deg, #0f1220 0%, #0d101a 100%)", flexShrink: 0, boxShadow: "0 1px 0 rgba(91,141,239,0.06)" },
  brandingGroup: { display: "flex", alignItems: "center", gap: "12px", flexShrink: 0 },
  brandIcon: { fontSize: "20px", color: "#5b8def", filter: "drop-shadow(0 0 6px rgba(91,141,239,0.4))" },
  logoText: { fontSize: "17px", fontWeight: "800", fontFamily: '"Inter", system-ui, sans-serif', letterSpacing: "-0.01em", color: "#f4f6fa", display: "flex", alignItems: "baseline", gap: "8px" },
  logoVersion: { fontSize: "10px", fontWeight: "700", fontFamily: '"JetBrains Mono", monospace', color: "#7c8698", backgroundColor: "#161b28", border: "1px solid #232a3c", borderRadius: "4px", padding: "2px 6px", letterSpacing: "0.03em" },
  switchTokenLink: { background: "transparent", border: "none", color: "#5c6478", fontSize: "10px", fontFamily: "inherit", cursor: "pointer", textDecoration: "underline", padding: 0, marginLeft: "4px" },
  systemStatusRibbon: { display: "flex", flexWrap: "wrap", gap: "0px", backgroundColor: "#05070c", padding: "4px", borderRadius: "8px", border: "1px solid #1a2030" },
  statusPill: { backgroundColor: "transparent", padding: "4px 12px", display: "flex", alignItems: "center", gap: "8px", fontSize: "11px", borderRight: "1px solid #1a2030" },
  statusPillLast: { backgroundColor: "transparent", padding: "4px 12px", display: "flex", alignItems: "center", gap: "8px", fontSize: "11px" },
  metaLabel: { color: "#5c6478", fontWeight: "600" },
  metaValue: { color: "#5b8def", fontWeight: "700", transition: "color 0.25s ease" },
  creditsDollar: { color: "#5c6478", fontWeight: "600", fontSize: "10px" },
  mainWorkspace: { display: "flex", flex: 1, width: "100%", overflow: "hidden", boxSizing: "border-box" },
  controlSidebar: { width: "300px", borderRight: "1px solid #1a2030", backgroundColor: "#0a0d15", display: "flex", flexDirection: "column", gap: "1px", overflowY: "auto", padding: "12px", boxSizing: "border-box" },
  sectionCard: { backgroundColor: "#0d111c", border: "1px solid #1a2030", borderRadius: "8px", padding: "14px", marginBottom: "12px", display: "flex", flexDirection: "column", boxShadow: "0 1px 0 rgba(255,255,255,0.02) inset, 0 6px 16px -14px rgba(0,0,0,0.8)" },
  cardHeaderStrip: { fontSize: "11px", fontWeight: "700", color: "#8b93a7", letterSpacing: "0.08em", display: "flex", alignItems: "center", gap: "6px", marginBottom: "12px", borderBottom: "1px solid #1a2030", paddingBottom: "6px" },
  cardHeaderIcon: { fontSize: "12px" },
  buttonStack: { display: "flex", flexDirection: "column", gap: "8px" },
  primaryButton: { backgroundColor: "#3f6fdb", backgroundImage: "linear-gradient(135deg, #6d97f2 0%, #3a63c7 100%)", color: "#fff", border: "1px solid rgba(109,151,242,0.4)", padding: "10px 14px", borderRadius: "6px", fontSize: "12px", fontWeight: "600", cursor: "pointer", fontFamily: "inherit", textAlign: "left", boxShadow: "0 4px 12px -6px rgba(63,111,219,0.55)" },
  secondaryButton: { backgroundColor: "#141a28", color: "#9aa2b6", border: "1px solid #262e42", padding: "10px 14px", borderRadius: "6px", fontSize: "12px", fontWeight: "600", cursor: "pointer", fontFamily: "inherit", textAlign: "left" },
  imageBox: { height: "auto", backgroundColor: "#05070c", borderRadius: "6px", border: "1px dashed #262e42", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", minHeight: "80px" },
  emptyBoxPlaceholder: { fontSize: "10px", color: "#454e63", letterSpacing: "0.05em" },
  sidebarVideoWrapper: { aspectRatio: "3/4", backgroundColor: "#05070c", borderRadius: "6px", overflow: "hidden", border: "1px solid #1a2030" },
  parameterRow: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", fontSize: "11px" },
  paramLabel: { color: "#6b7385", fontWeight: "600" },
  paramSliderGroup: { display: "flex", alignItems: "center", gap: "8px" },
  paramSlider: { width: "100px", accentColor: "#5b8def" },
  paramValue: { color: "#5b8def", fontWeight: "700", fontSize: "11px", minWidth: "32px", textAlign: "right" },
  paramCheckbox: { width: "14px", height: "14px", accentColor: "#5b8def" },
  paramSelect: { backgroundColor: "#05070c", color: "#e6e9ef", border: "1px solid #262e42", borderRadius: "5px", padding: "4px 8px", fontFamily: "inherit", fontSize: "11px" },
  voiceSelectGroup: { display: "flex", flexDirection: "column", gap: "6px", marginBottom: "10px" },
  voiceSelect: { width: "100%", maxWidth: "100%", boxSizing: "border-box", backgroundColor: "#05070c", color: "#e6e9ef", border: "1px solid #262e42", borderRadius: "5px", padding: "6px 8px", fontFamily: "inherit", fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  paramsLockedNote: { fontSize: "10px", color: "#5c6478", fontStyle: "italic", marginTop: "4px", paddingTop: "8px", borderTop: "1px solid #1a2030" },
  creditBalanceRow: { display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "8px" },
  creditBalanceNumber: { fontSize: "22px", fontWeight: "800", fontFamily: '"Inter", system-ui, sans-serif', color: "#f4f6fa" },
  creditBalanceSub: { fontSize: "10px", color: "#5c6478" },
  creditBarTrack: { width: "100%", height: "6px", borderRadius: "3px", backgroundColor: "#161b28", overflow: "hidden", marginBottom: "8px" },
  creditBarFill: { height: "100%", borderRadius: "3px", transition: "width 0.6s linear, background-color 0.3s ease" },
  creditMeta: { display: "flex", flexDirection: "column", gap: "2px", fontSize: "10px", color: "#5c6478", marginBottom: "10px" },
  ledgerErrorNote: { fontSize: "10px", color: "#f0576a", lineHeight: "1.5", marginBottom: "10px" },
  topUpButton: { backgroundColor: "#141a28", color: "#9aa2b6", border: "1px dashed #3a4356", padding: "8px 12px", borderRadius: "6px", fontSize: "11px", fontWeight: "600", cursor: "pointer", fontFamily: "inherit" },
  modalSubtitle: { fontSize: "11px", color: "#6b7385", margin: "0 0 14px" },
  creditCardGrid: { display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "10px" },
  creditCard: { position: "relative", backgroundColor: "#05070c", border: "1px solid #1a2030", borderRadius: "10px", padding: "14px 8px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: "4px" },
  creditCardPopular: { border: "1px solid #e6e9ef", boxShadow: "0 0 0 1px rgba(230,233,239,0.15)" },
  popularBadge: { position: "absolute", top: "-9px", left: "50%", transform: "translateX(-50%)", backgroundColor: "#3f6fdb", color: "#fff", fontSize: "8px", fontWeight: "700", padding: "2px 8px", borderRadius: "999px", letterSpacing: "0.04em", whiteSpace: "nowrap" },
  creditCardIcon: { width: "28px", height: "28px", borderRadius: "50%", backgroundColor: "#1c2333", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", color: "#7c8698", marginBottom: "4px" },
  creditCardIconPopular: { backgroundColor: "#3f6fdb", color: "#fff" },
  creditCardAmount: { fontSize: "14px", fontWeight: "800", fontFamily: '"Inter", system-ui, sans-serif', color: "#f4f6fa" },
  creditCardLabel: { fontSize: "9px", color: "#6b7385", marginBottom: "6px" },
  creditCardBuyBtn: { width: "100%", backgroundColor: "transparent", color: "#e6e9ef", border: "1px solid #2a3348", padding: "6px 6px", borderRadius: "999px", fontSize: "10px", fontWeight: "600", cursor: "pointer", fontFamily: "inherit" },
  creditCardBuyBtnPopular: { backgroundColor: "#f4f6fa", color: "#090b11", border: "1px solid #f4f6fa" },
  modalNote: { fontSize: "9px", color: "#454e63", fontStyle: "italic", marginTop: "12px", textAlign: "center" },
  sectionCardAlert: { border: "1px solid #f0576a", boxShadow: "0 0 0 3px rgba(240,87,106,0.15)" },
  outputCanvas: { flex: 1, display: "flex", flexDirection: "column", backgroundColor: "#050710", overflow: "hidden" },
  canvasControlBar: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 24px", borderBottom: "1px solid #1a2030", backgroundColor: "#0d101a", flexShrink: 0 },
  canvasTitleGroup: { display: "flex", flexDirection: "column", gap: "2px" },
  canvasTitle: { fontSize: "14px", fontWeight: "700", color: "#f4f6fa", margin: 0, letterSpacing: "0.05em" },
  canvasSubtitle: { fontSize: "11px", color: "#5c6478" },
  actionRow: { display: "flex", gap: "10px" },
  actionButton: { border: "1px solid transparent", padding: "10px 20px", borderRadius: "6px", fontSize: "12px", fontWeight: "700", cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.02em" },
  startButton: { backgroundColor: "#22c55e", backgroundImage: "linear-gradient(135deg, #4ade80 0%, #16a34a 100%)", color: "#fff", boxShadow: "0 4px 14px -6px rgba(34,197,94,0.5)" },
  stopButton: { backgroundColor: "#f0576a", backgroundImage: "linear-gradient(135deg, #fb7185 0%, #dc3a52 100%)", color: "#fff", boxShadow: "0 4px 14px -6px rgba(240,87,106,0.5)" },
  popOutButton: { backgroundColor: "#141a28", color: "#9aa2b6", border: "1px solid #262e42" },
  canvasViewportContainer: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "20px", overflow: "hidden" },
  outputColumn: { display: "flex", flexDirection: "column", alignItems: "center", gap: "10px", width: "100%" },
  timerBadgeRow: { display: "flex", gap: "10px" },
  timerBadgeOutside: { backgroundColor: "#0d111c", border: "1px solid #1a2030", borderRadius: "6px", padding: "6px 16px", fontSize: "13px", fontWeight: "700", color: "#5b8def", letterSpacing: "0.08em" },
  fixedOutputContainer: { width: "960px", maxWidth: "100%", aspectRatio: "16/9", backgroundColor: "#000", borderRadius: "8px", border: "1px solid #1a2030", position: "relative", overflow: "hidden", boxShadow: "0 30px 60px -20px rgba(0,0,0,0.8), 0 0 0 1px rgba(91,141,239,0.05)" },
  mirroredVideo: { width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" },
  fittedImage: { width: "100%", height: "100%", objectFit: "contain" },
  canvasOverlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(5, 7, 12, 0.94)" },
  overlayPingWrap: { position: "relative", width: "24px", height: "24px", marginBottom: "16px", display: "flex", alignItems: "center", justifyContent: "center" },
  overlayRadarPing: { position: "absolute", width: "24px", height: "24px", borderRadius: "50%", border: "2px solid #f0576a", animation: "radarPing 1.8s cubic-bezier(0.2,0.6,0.4,1) infinite" },
  overlayPingDot: { position: "absolute", width: "7px", height: "7px", borderRadius: "50%", backgroundColor: "#f0576a", boxShadow: "0 0 8px 1px rgba(240,87,106,0.7)" },
  overlayText: { fontSize: "13px", fontWeight: "700", color: "#6b7385", letterSpacing: "0.05em", marginBottom: "4px" },
  overlaySubtext: { fontSize: "11px", color: "#3a4256" },
};