import React, { useState, useRef, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createDecartClient, models } from "@decartai/sdk";
import AccessGate from "./AccessGate.jsx";
import { LogoLockup } from "./Logo.jsx";
import { WHATSAPP_NUMBER, WHATSAPP_DEFAULT_MESSAGE, WHATSAPP_TRIAL_PURCHASE_MESSAGE } from "./siteConfig.js";
import WhatsAppLink from "./WhatsAppLink.jsx";
import { theme } from "./theme.js";
import {
  LEDGER_URL,
  checkAccessToken,
  normalizeAccessToken,
} from "./ledgerClient.js";
import {
  DISPLAY_CREDITS_PER_SECOND,
  DISPLAY_NAIRA_PER_USD,
  EFFECTIVE_CREDITS_PER_SECOND,
  HEARTBEAT_INTERVAL_MS,
  LOW_CREDIT_THRESHOLD,
  BACKGROUND_MIN_PURCHASE_CREDITS,
  VOICE_MIN_PURCHASE_CREDITS,
  TOP_UP_OPTIONS,
  formatUsdFromCredits,
  formatUsdFromNaira,
  formatNaira,
  formatLiveTimeFromCredits,
  formatRemainingLiveTime,
} from "./pricing.js";
import { checkForNewerShellRelease } from "./shellUpdate.js";
import {
  assessNetworkQuality,
  NETWORK_QUALITY,
  networkQualityLabel,
} from "./networkCheck.js";
import {
  BACKGROUND_SCENES,
  OUTPUT_QUALITY_OPTIONS,
  OUTPUT_QUALITY_STORAGE_KEY,
  SCENE_APPLY_TARGET_MS,
  STUDIO_PANEL_SECTIONS,
  findBackgroundScene,
  getOutputQualityConfig,
  readStoredOutputQuality,
  studioNavSections,
} from "./backgroundScenes.js";

const { colors: c, gradients: g, fonts: f, radius: r, shadow: s } = theme;
const fd = f.display;

function formatStatusDisplay(raw) {
  const exact = {
    "SYSTEM STANDBY": "Ready",
    "DEVICE READY // AWAITING DISPATCH": "Camera ready",
    "PAYLOAD READY FOR TRANSMISSION": "Reference loaded",
    "PROVISIONING MEDIA INPUTS...": "Starting camera…",
    "HANDSHAKING WITH DECART WEBRTC CLUSTER...": "Connecting…",
    "CONNECTED — WAITING FOR TRANSFORM…": "Connected · waiting for video…",
    "GENERATING TRANSFORM…": "Generating…",
    "COMPUTE LINK ONLINE // REALTIME TRANSFORMATION TERMINAL": "Live",
    "PROMPT UPDATED // LIVE TRANSFORMATION": "Prompt updated",
    "SCENE UPDATED // LIVE TRANSFORMATION": "Scene updated",
    "PIPELINE DISCONNECTED": "Stopped",
    "PIPELINE TERMINATED": "Stopped",
    "CONNECT TIMEOUT — NO TRANSFORM VIDEO": "Timed out · no transform",
    "INSTALLING DRIVERS — APPROVE UAC": "Installing drivers…",
    "CHECKOUT CANCELLED": "Checkout cancelled",
    "REDIRECTING TO CHECKOUT...": "Opening checkout…",
    "OPENING CHECKOUT": "Opening checkout…",
    "TRIAL CHECKOUT LOCKED — CONTACT ADMIN TO PURCHASE": "Trial ended · contact admin to buy",
    "DECART RECONNECTING…": "Reconnecting…",
  };
  if (exact[raw]) return exact[raw];
  if (raw.startsWith("OPENING CHECKOUT")) return "Opening checkout…";
  if (raw.startsWith("TRIAL ENDED")) return "Trial ended · message WhatsApp";
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

// Dev-only fallback when ledger Decart token mint is unavailable locally.
const MY_DECART_KEY = (import.meta.env?.VITE_DECART_API_KEY || "").trim();

// How long a live transformation session is allowed to run before auto-stopping.
// Paid users: no UX cap (credits / Decart session token decide).
// Trial accounts: Lucy-style 60s Decart maxSessionDuration + client backup stop.
const TRIAL_MAX_SESSION_SECONDS = 60;

// --- Real credit ledger backend --------------------------------------------
// See /ledger-backend. The browser NEVER decides the balance — it only ever
// displays whatever this server last reported. Pricing tiers live in pricing.js.

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

function isMobileUserAgent() {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent || "");
}

function getStreamFacingMode(stream) {
  return stream?.getVideoTracks?.()[0]?.getSettings?.()?.facingMode || "";
}

// Decart pre-flips the input so movement matches what you see (raise right hand → right on screen).
// Desktop webcams usually omit facingMode, so default to true per Decart docs.
function resolveDecartMirrorMode(stream) {
  const facingMode = getStreamFacingMode(stream);
  if (facingMode === "environment") return false;
  if (facingMode === "user") return "auto";
  return true;
}

function resolveLocalPreviewMirror(stream) {
  return resolveDecartMirrorMode(stream) !== false;
}

function drawVideoFrame(ctx, video, destWidth, destHeight, fit = "cover") {
  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  if (!srcW || !srcH) return;

  ctx.imageSmoothingEnabled = true;
  if (typeof ctx.imageSmoothingQuality !== "undefined") {
    ctx.imageSmoothingQuality = "high";
  }

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, destWidth, destHeight);

  if (srcW === destWidth && srcH === destHeight) {
    ctx.drawImage(video, 0, 0);
    return;
  }

  if (fit === "stretch") {
    ctx.drawImage(video, 0, 0, destWidth, destHeight);
    return;
  }

  const srcAspect = srcW / srcH;
  const dstAspect = destWidth / destHeight;

  if (fit === "contain") {
    let dw;
    let dh;
    let dx;
    let dy;
    if (srcAspect > dstAspect) {
      dw = destWidth;
      dh = destWidth / srcAspect;
      dx = 0;
      dy = (destHeight - dh) / 2;
    } else {
      dh = destHeight;
      dw = destHeight * srcAspect;
      dx = (destWidth - dw) / 2;
      dy = 0;
    }
    ctx.drawImage(video, dx, dy, dw, dh);
    return;
  }

  let sx;
  let sy;
  let sw;
  let sh;
  if (srcAspect > dstAspect) {
    sh = srcH;
    sw = srcH * dstAspect;
    sx = (srcW - sw) / 2;
    sy = 0;
  } else {
    sw = srcW;
    sh = srcW / dstAspect;
    sx = 0;
    sy = (srcH - sh) / 2;
  }
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, destWidth, destHeight);
}

const REFERENCE_UPLOAD_MAX_EDGE = 1920;
const DECART_PREWARM_TTL_MS = 4 * 60 * 1000;
/** Abort & disconnect Decart if transform video never arrives (caps Decart metering). */
const TRANSFORM_CONNECT_TIMEOUT_MS = 8000;
/** Desktop: WebRTC + first frame often needs longer than web (cold start / scene upload). */
const TRANSFORM_CONNECT_TIMEOUT_DESKTOP_MS = 20000;
/** Absolute ceiling while realtime.connect() itself is still in flight. */
const TRANSFORM_HANDSHAKE_CEILING_MS = 45000;
const TRANSFORM_HANDSHAKE_CEILING_DESKTOP_MS = 60000;
const DECART_PRESET_DEDUP_MS = 900;

function drawIdleVirtualCamFrame(ctx, width, height) {
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);
  const fontSize = Math.max(14, Math.round(width * 0.022));
  const padX = Math.max(16, Math.round(width * 0.025));
  const padY = Math.max(12, Math.round(height * 0.03));
  ctx.fillStyle = "rgba(255, 255, 255, 0.88)";
  ctx.font = `600 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText("InspireTech Camera", width - padX, padY);
}

async function loadImageFile(file) {
  const objectUrl = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not decode image"));
      img.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function drawHtmlImageCover(ctx, img, destX, destY, destWidth, destHeight) {
  const srcW = img.naturalWidth || 1;
  const srcH = img.naturalHeight || 1;
  const srcAspect = srcW / srcH;
  const dstAspect = destWidth / destHeight;
  let sx;
  let sy;
  let sw;
  let sh;
  if (srcAspect > dstAspect) {
    sh = srcH;
    sw = srcH * dstAspect;
    sx = (srcW - sw) / 2;
    sy = 0;
  } else {
    sw = srcW;
    sh = srcW / dstAspect;
    sx = 0;
    sy = (srcH - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, destX, destY, destWidth, destHeight);
}

/**
 * Decart accepts only one reference image. Scene presets are empty rooms, so we
 * composite the character photo onto the scene JPG — same structure as a
 * reference photo that already has person + environment.
 */
async function composeSceneReferenceImage(sceneFile, characterFile) {
  const [sceneImg, charImg] = await Promise.all([
    loadImageFile(sceneFile),
    loadImageFile(characterFile),
  ]);
  // Match Full HD / reference upload edge so scene+character isn't softer than a plain reference.
  const width = 1920;
  const height = 1080;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not compose scene reference");

  drawHtmlImageCover(ctx, sceneImg, 0, 0, width, height);

  // Place the character large in-frame (portrait-scale), same visual weight as a solo reference.
  const charMaxH = Math.round(height * 0.92);
  const charAspect = (charImg.naturalWidth || 1) / (charImg.naturalHeight || 1);
  let charH = charMaxH;
  let charW = Math.round(charH * charAspect);
  if (charW > width * 0.72) {
    charW = Math.round(width * 0.72);
    charH = Math.round(charW / charAspect);
  }
  const charX = Math.round((width - charW) / 2);
  const charY = height - charH;
  ctx.drawImage(charImg, charX, charY, charW, charH);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.93));
  if (!blob) throw new Error("Could not encode scene reference");
  const sceneStem = sceneFile.name.replace(/\.[^.]+$/, "") || "scene";
  return new File([blob], `${sceneStem}-with-character.jpg`, { type: "image/jpeg" });
}

async function prepareReferenceImageForUpload(file) {
  if (!file || typeof document === "undefined") return file;
  if (!String(file.type || "").startsWith("image/")) return file;
  if (file.size < 450_000 && /jpe?g$/i.test(file.type)) return file;

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not decode reference image"));
      img.src = objectUrl;
    });
    const maxEdge = Math.max(image.naturalWidth || 0, image.naturalHeight || 0);
    const scale = maxEdge > REFERENCE_UPLOAD_MAX_EDGE ? REFERENCE_UPLOAD_MAX_EDGE / maxEdge : 1;
    const width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
    const height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(image, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) return file;
    const baseName = file.name.replace(/\.[^.]+$/, "") || "reference";
    return new File([blob], `${baseName}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

const DEFAULT_TRANSFORMATION_PROMPT =
  "Substitute the character in the video with the person in the reference image, matching their full appearance exactly as shown in the reference — clothing, hair, skin tone, and body shape only; do not add a hat, cap, glasses, jewelry, or any accessory that is not clearly visible in the reference image.";
const CHARACTER_WITH_REF_PROMPT = DEFAULT_TRANSFORMATION_PROMPT;
const CHARACTER_SWAP_PATTERN =
  /substitute the character|replace the character|transform into this character|person in the reference image|character from the reference image|with this character/i;
const BACKGROUND_INTENT_PATTERN =
  /background|office|beach|studio|city|skyline|environment|room|setting|scene|backdrop|interior|outdoor|setup|suite|hotel|luxury|presidential|executive|broadcast|penthouse/i;
const DEFAULT_BACKGROUND_PROMPT =
  "Change the background to a bright modern office with desk, chair, window light, soft afternoon shadows, coworkers passing in the background, and sunlight on the floor.";
const REFERENCE_BACKGROUND_PROMPT =
  "Change the background to closely match the environment, setting, and mood shown in the reference image — recreate the same type of room, location, layout, colors, materials, lighting direction, and depth cues with photorealistic detail filling every pixel edge to edge behind the person; when exact pixels are unavailable, infer and synthesize the closest plausible match to the reference scene rather than leaving the original webcam room visible; completely remove and replace the entire original webcam room with zero visible bleed-through, ghosting, edges, or leftover walls, furniture, or lighting from the live camera feed.";
const REFERENCE_BACKGROUND_ENHANCE_SUFFIX =
  " Maximize environmental fidelity with rich textures, crisp depth, accurate colors, fine surface detail, consistent ambient lighting, and stable background geometry that stays aligned with the reference scene.";
const TEMPORAL_STABILITY_CLAUSE =
  " Keep the subject and background spatially stable frame-to-frame when the input camera is still — no sway, drift, idle motion, breathing wobble on static poses, or background shimmer.";
function hasBackgroundIntent(text) {
  return BACKGROUND_INTENT_PATTERN.test(String(text || "").trim());
}

function normalizeBackgroundClause(text) {
  let clause = String(text || "").trim();
  if (!clause) return DEFAULT_BACKGROUND_PROMPT;

  clause = clause
    .replace(/^change (my |the )?(entire )?background (to|with)\s*/i, "")
    .replace(/^replace (my |the )?(entire )?background (to|with)\s*/i, "")
    .replace(/^place them in\s*/i, "")
    .replace(/^put me in\s*/i, "")
    .replace(/^set the background to\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");

  if (!clause) return DEFAULT_BACKGROUND_PROMPT;
  if (/^change the background to/i.test(clause)) {
    const base = clause.endsWith(".") ? clause.slice(0, -1) : clause;
    return `${base}, completely replacing the entire frame behind the person edge to edge with the new environment and erasing every pixel of the original webcam room, walls, furniture, and ambient lighting with no bleed-through or ghosting.`;
  }
  return `Change the background to ${clause}, completely replacing the entire frame behind the person edge to edge with the new environment and erasing every pixel of the original webcam room, walls, furniture, and ambient lighting with no bleed-through or ghosting.`;
}

function composeBackgroundOnlyPrompt(userText) {
  // Pure scene swap — no "keep person unchanged" clause (that anchors to the live webcam body).
  return normalizeBackgroundClause(userText);
}

function composeReferenceBackgroundPrompt() {
  return `${REFERENCE_BACKGROUND_PROMPT}${REFERENCE_BACKGROUND_ENHANCE_SUFFIX}${TEMPORAL_STABILITY_CLAUSE}`;
}

function composeLayeredPrompt(userText, hasReferenceImage = true, options = {}) {
  const { useReferenceBackground = false } = options;
  const trimmed = String(userText || "").trim();
  if (!hasReferenceImage) return composeTransformationPrompt(trimmed, false, options);
  const backgroundClause = useReferenceBackground
    ? composeReferenceBackgroundPrompt(options)
    : composeBackgroundOnlyPrompt(trimmed || DEFAULT_BACKGROUND_PROMPT);
  // Decart layered edits: one sentence per edit type (see lucy-2.5-prompting guide).
  return `${backgroundClause} ${CHARACTER_WITH_REF_PROMPT}`;
}

/** Scene library uses a composite (character + room) — same layered prompt as reference photo background. */
function composeSceneLibraryPrompt() {
  return composeLayeredPrompt("", true, { useReferenceBackground: true });
}

function composeTransformationPrompt(userText, hasReferenceImage = true, options = {}) {
  const { useReferenceBackground = false } = options;
  const trimmed = String(userText || "").trim();
  const refBackground = useReferenceBackground && hasReferenceImage;
  const wantsBackground = refBackground || hasBackgroundIntent(trimmed);

  if (!hasReferenceImage) {
    if (!trimmed) return DEFAULT_BACKGROUND_PROMPT;
    if (wantsBackground) return normalizeBackgroundClause(trimmed);
    return trimmed;
  }

  if (refBackground) {
    return composeLayeredPrompt(trimmed, true, options);
  }

  if (!trimmed || trimmed === DEFAULT_TRANSFORMATION_PROMPT) {
    return wantsBackground
      ? composeLayeredPrompt(trimmed || DEFAULT_BACKGROUND_PROMPT, true, options)
      : CHARACTER_WITH_REF_PROMPT;
  }

  if (wantsBackground) {
    return composeLayeredPrompt(trimmed, true, options);
  }

  if (CHARACTER_SWAP_PATTERN.test(trimmed)) {
    return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
  }

  return `${CHARACTER_WITH_REF_PROMPT} ${trimmed.endsWith(".") ? trimmed : `${trimmed}.`}`;
}

function shouldEnhanceDecartPrompt(_userText, enhanceEnabled) {
  // Lucy 2.5 expects enhance on — it rewrites prompts into Decart's structured format.
  return enhanceEnabled !== false;
}

// Real-time voice conversion server (voice-rt-server on RunPod) — a
// continuous WebSocket alternative to the ElevenLabs chunk-based pipeline
// above. See /voice-rt-server/README.md for what this actually is and why
// it's architecturally different (no per-chunk delay).
const VOICE_RT_URL = import.meta.env?.VITE_VOICE_RT_URL || "";
const VOICE_RT_FRAME_SAMPLES_DEFAULT = 6400; // 400ms @ 16kHz — must match voice-rt-server FRAME_MS (synced from /voices)

const VOICE_UPGRADE_MESSAGE = `Voice changer requires a plan of at least ${VOICE_MIN_PURCHASE_CREDITS.toLocaleString()} credits/month. Upgrade in Credits below.`;
const BACKGROUND_UPGRADE_MESSAGE = `Background prompt and reference background require a plan of at least ${BACKGROUND_MIN_PURCHASE_CREDITS.toLocaleString()} credits/month. Upgrade in Credits below.`;

export default function App() {
  const navigate = useNavigate();
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("SYSTEM STANDBY");
  const [selectedFile, setSelectedFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);

  const [latency, setLatency] = useState("0 ms");
  const [fps, setFps] = useState(0);

  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const [outputQuality, setOutputQuality] = useState(readStoredOutputQuality);
  const [enhanceMask, setEnhanceMask] = useState(true);
  const [inferenceWeight, setInferenceWeight] = useState(98);
  const [useReferenceBackground, setUseReferenceBackground] = useState(false);
  const [transformationPrompt, setTransformationPrompt] = useState(DEFAULT_TRANSFORMATION_PROMPT);
  const [activeBackgroundSceneId, setActiveBackgroundSceneId] = useState("");
  const [applyingSceneId, setApplyingSceneId] = useState("");
  const [sceneTransitionActive, setSceneTransitionActive] = useState(false);
  const [backgroundUpdatedNote, setBackgroundUpdatedNote] = useState("");
  const [showCustomPrompt, setShowCustomPrompt] = useState(false);
  const [promptApplyBusy, setPromptApplyBusy] = useState(false);
  const [promptApplyNote, setPromptApplyNote] = useState("");
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
  const [mirrorLocalPreview, setMirrorLocalPreview] = useState(false);
  const [mobileMicEnabled, setMobileMicEnabled] = useState(() => {
    try {
      return window.localStorage.getItem("inspiretech_mobile_mic") !== "0";
    } catch {
      return true;
    }
  });
  const selectedVideoDeviceIdRef = useRef("");
  const selectedVideoDeviceLabelRef = useRef("");
  const selectedAudioDeviceIdRef = useRef("");

  const MODEL_ID_MAP = {
    "lucy-realtime-v2.5": "lucy-2.5", // current flagship — released after this app was first built
    "lucy-realtime-v2.1": "lucy-2.1",
    "lucy-speed-v1.9": "lucy-1.9",
  };
  const getModelId = () => MODEL_ID_MAP[activeModel] || "lucy-2.5";
  const getRealtimeModel = () => models.realtime(getModelId());

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
  const [driverCameraInstalled, setDriverCameraInstalled] = useState(null);
  const [driverAudioInstalled, setDriverAudioInstalled] = useState(null);
  const [vbCableBundled, setVbCableBundled] = useState(null);
  const [appUpdateOpen, setAppUpdateOpen] = useState(false);
  const [appUpdateInfo, setAppUpdateInfo] = useState(null);
  const [appUpdatePhase, setAppUpdatePhase] = useState("available");
  const [appUpdateProgress, setAppUpdateProgress] = useState(0);
  const [appUpdateBusy, setAppUpdateBusy] = useState(false);
  const [appUpdateError, setAppUpdateError] = useState("");
  const [desktopAppVersion, setDesktopAppVersion] = useState("");
  const [companionNavSection, setCompanionNavSection] = useState("studio");
  const appUpdateManualCheckRef = useRef(false);
  const appUpdateResolvedRef = useRef(false);

  const isCompanionApp = () =>
    typeof window !== "undefined" && Boolean(window.inspiretechCompanion?.isDesktop);
  const companionToolbar = isCompanionApp();

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
    setVoiceChangerAccess(false);
    setBackgroundChangerAccess(false);
    setTierAccessLoaded(false);
    try {
      window.localStorage.removeItem("inspiretech_access_token");
    } catch {
      // ignore
    }
  };

  // --- Real credit balance state (sourced from the ledger backend) ---
  const [credits, setCredits] = useState(0);
  const [creditsLoaded, setCreditsLoaded] = useState(false);
  const [voiceChangerAccess, setVoiceChangerAccess] = useState(false);
  const [backgroundChangerAccess, setBackgroundChangerAccess] = useState(false);
  const [tierAccessLoaded, setTierAccessLoaded] = useState(false);
  const [allowPurchase, setAllowPurchase] = useState(true);
  const [isTrialAccount, setIsTrialAccount] = useState(false);
  const [ledgerUnreachable, setLedgerUnreachable] = useState(false);
  const [networkQuality, setNetworkQuality] = useState({
    level: NETWORK_QUALITY.UNKNOWN,
    latencyMs: null,
    message: "Checking connection…",
    checkedAt: 0,
  });
  const [networkChecked, setNetworkChecked] = useState(false);
  const [sessionCreditsUsed, setSessionCreditsUsed] = useState(0);
  const [showAddCredits, setShowAddCredits] = useState(false);
  const [selectedTopUp, setSelectedTopUp] = useState(null);
  const [checkoutContactError, setCheckoutContactError] = useState("");
  const [isPoppedOut, setIsPoppedOut] = useState(false);
  const [mobileOutputFocus, setMobileOutputFocus] = useState(false);
  const [theaterControlsVisible, setTheaterControlsVisible] = useState(true);
  const [mobileControlsOpen, setMobileControlsOpen] = useState(false);
  const [isMobileLayout, setIsMobileLayout] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia(`(max-width: ${MOBILE_LAYOUT_MAX_WIDTH}px)`).matches
      : false
  );
  const isMobileWebStudio = isMobileLayout && !companionToolbar;
  const proStudioShell = !isMobileLayout && !isMobileWebStudio;
  const studioNavItems = studioNavSections(companionToolbar);
  const pipSupported = typeof document !== "undefined" && document.pictureInPictureEnabled;
  const outputTheaterSupported = typeof document !== "undefined";

  const localVideoRef = useRef(null);
  const outputVideoRef = useRef(null);
  const companionCanvasRef = useRef(null);
  const companionCaptureIntervalRef = useRef(null);
  const companionAudioRef = useRef(null);
  const desktopCaptureFrameRef = useRef(null); // requestAnimationFrame id, only used inside the Electron shell
  const fileInputRef = useRef(null);
  const localStreamRef = useRef(null);
  const realtimeClientRef = useRef(null);
  const referenceImageRefId = useRef(null);
  const referenceImageSourceRef = useRef(null);
  const referenceBoundToFileRef = useRef(null);
  const referenceUploadGenerationRef = useRef(0);
  const imagePreviewUrlRef = useRef(null);
  const activeScenePromptRef = useRef(null);
  const activeSceneUseRefBackgroundRef = useRef(false);
  const activeSceneImageIdRef = useRef("");
  const sceneCompositeCacheRef = useRef(new Map());
  const decartSetGuardRef = useRef({ inFlight: false, lastKey: "", lastAt: 0, reconnectAt: 0 });
  const fpsIntervalRef = useRef(null);
  const clockTimerRef = useRef(null); // the local 5-min UX countdown (not billing)
  const heartbeatTimerRef = useRef(null); // the real billing tick, talking to the server
  const billingSessionIdRef = useRef(null);
  const billingCreditsStartRef = useRef(0);
  const creditsRef = useRef(0);
  const isTrialAccountRef = useRef(false);
  const allowPurchaseRef = useRef(true);
  const sessionCreditsUsedRef = useRef(0);
  const heartbeatFailCountRef = useRef(0);
  const heartbeatInFlightRef = useRef(false);
  const decartGenerationSecondsRef = useRef(0);
  const decartSecondsAtBillingStartRef = useRef(0);
  const billingStartInFlightRef = useRef(false);
  const billingEndInFlightRef = useRef(null);
  const billingOpenFallbackRef = useRef(null);
  const transformOutputReadyRef = useRef(false);
  const connectAttemptRef = useRef(0);
  const theaterControlsTimerRef = useRef(null);
  const creditSectionRef = useRef(null);
  const startInProgressRef = useRef(false);
  const isRunningRef = useRef(false);
  const mobileOutputFocusRef = useRef(false);
  const isMobileLayoutRef = useRef(
    typeof window !== "undefined"
      ? window.matchMedia(`(max-width: ${MOBILE_LAYOUT_MAX_WIDTH}px)`).matches
      : false
  );
  const nativeVideoFullscreenRef = useRef(false);
  const decartPrewarmRef = useRef({ apiKey: null, fetchedAt: 0, expiresAt: null, uploadPromise: null });
  const trialSessionCapRef = useRef(0);
  const preparedReferenceFileRef = useRef(null);
  const stopTransformationRef = useRef(() => {});

  const setRunningState = (value) => {
    isRunningRef.current = value;
    setIsRunning(value);
  };

  const setMobileTheaterFocus = (value) => {
    mobileOutputFocusRef.current = value;
    setMobileOutputFocus(value);
  };

  const shouldUseMobileTheater = () =>
    isMobileLayoutRef.current || isMobileUserAgent();

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
    const model = getRealtimeModel();
    const targetWidth = model.width;
    const targetHeight = model.height;
    const constraints = {
      frameRate: relaxed ? { ideal: 30 } : { ideal: 30, max: 30 },
      width: relaxed ? { ideal: targetWidth } : { ideal: targetWidth, max: targetWidth },
      height: relaxed ? { ideal: targetHeight } : { ideal: targetHeight, max: targetHeight },
    };
    if ((isMobileLayout || isMobileUserAgent()) && !deviceId) {
      constraints.facingMode = "user";
    }
    if (deviceId) {
      constraints.deviceId = strictDevice ? { exact: deviceId } : { ideal: deviceId };
    }
    return constraints;
  };

  const applyStableVideoTrackSettings = (track) => {
    if (!track?.applyConstraints) return;
    const model = getRealtimeModel();
    track
      .applyConstraints({
        frameRate: { ideal: 30, max: 30 },
        width: { ideal: model.width, max: model.width },
        height: { ideal: model.height, max: model.height },
      })
      .catch(() => {});
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
    const includeMicrophone = !isMobileLayout || mobileMicEnabled;
    const audio = includeMicrophone ? buildAudioConstraints(selectedAudioDeviceIdRef.current) : false;
    if (!deviceId) {
      return navigator.mediaDevices.getUserMedia({
        ...(includeMicrophone ? { audio } : {}),
        video: buildVideoConstraints(""),
      });
    }

    try {
      return await navigator.mediaDevices.getUserMedia({
        ...(includeMicrophone ? { audio } : {}),
        video: buildVideoConstraints(deviceId, { strictDevice: true }),
      });
    } catch (err) {
      if (err?.name !== "OverconstrainedError" && err?.name !== "NotFoundError") {
        throw err;
      }
      // Same device, looser resolution — still keep deviceId exact so we don't fall back to DroidCam.
      return navigator.mediaDevices.getUserMedia({
        ...(includeMicrophone ? { audio } : {}),
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

  useEffect(() => {
    if (!selectedFile) setUseReferenceBackground(false);
  }, [selectedFile]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(OUTPUT_QUALITY_STORAGE_KEY, outputQuality);
  }, [outputQuality]);

  // Prewarm Decart credentials + reference upload while idle — no realtime session opened.
  useEffect(() => {
    if (!accessToken || !selectedFile || !cameraActive || ledgerUnreachable) return;
    void prewarmReferenceImageUpload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, selectedFile, cameraActive, ledgerUnreachable, useReferenceBackground]);

  const stopLocalVideoStream = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    setCameraActive(false);
    setMirrorLocalPreview(false);
  };

  // --- Fetch the real balance on load, and handle returning from Flutterwave Checkout ---
  useEffect(() => {
    if (!accessToken || !sessionReady) return;
    refreshBalance();

    const hashQuery = window.location.hash.includes("?")
      ? window.location.hash.slice(window.location.hash.indexOf("?") + 1)
      : "";
    const params = new URLSearchParams(window.location.search || hashQuery);
    const checkoutResult = params.get("checkout");
    const paymentStatus = params.get("status");
    const reference =
      params.get("tx_ref") || params.get("reference") || params.get("trxref");
    const transactionId = params.get("transaction_id");

    if (checkoutResult || reference || paymentStatus) {
      const cleanPath = window.location.pathname + window.location.hash.split("?")[0];
      window.history.replaceState({}, "", cleanPath);

      if ((checkoutResult === "success" || paymentStatus === "successful") && reference) {
        setStatus("PAYMENT RECEIVED — VERIFYING...");
        verifyPurchase(reference, transactionId);
      } else if (checkoutResult === "cancel" || paymentStatus === "cancelled") {
        setStatus("CHECKOUT CANCELLED");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, sessionReady]);

  // Trial accounts: open purchase panel when credits hit zero (checkout stays locked → WhatsApp CTA).
  useEffect(() => {
    if (!creditsLoaded) return;
    if (isTrialAccount && !allowPurchase && credits <= 0) {
      setShowAddCredits(true);
    }
  }, [creditsLoaded, isTrialAccount, allowPurchase, credits]);

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
      syncTierAccessFromLedger(validation);
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

  const syncCompanionDriverStatus = (status) => {
    if (!status) return;
    setDriverCameraInstalled(status.cameraInstalled ?? null);
    setDriverAudioInstalled(status.audioInstalled ?? null);
    setVbCableBundled(status.vbCableBundled ?? null);
  };

  useEffect(() => {
    if (!isCompanionApp()) return undefined;
    let cancelled = false;
    window.inspiretechCompanion
      ?.getSetupStatus?.()
      .then((status) => {
        if (!cancelled) syncCompanionDriverStatus(status);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [driverSetupBusy, driverSetupFailed]);

  const showShellUpdateAvailable = (payload, { ignoreSnooze = false } = {}) => {
    if (!ignoreSnooze) {
      let snoozedUntil = 0;
      try {
        snoozedUntil = Number(window.localStorage.getItem("inspiretech_update_snooze_until") || 0);
      } catch {
        // ignore
      }
      if (Date.now() < snoozedUntil) return false;
    }

    appUpdateResolvedRef.current = true;
    setAppUpdateInfo(payload);
    setAppUpdatePhase("available");
    setAppUpdateProgress(0);
    setAppUpdateError("");
    setAppUpdateOpen(true);
    return true;
  };

  const runWebShellUpdateFallback = async (currentVersion, { manual = false } = {}) => {
    let version = String(currentVersion || "").trim();
    if (!version) {
      try {
        version = String((await window.inspiretechCompanion?.getAppVersion?.()) || "").trim();
      } catch {
        version = "";
      }
    }
    if (!version) return false;

    try {
      const release = await checkForNewerShellRelease(version);
      if (!release) {
        if (manual) {
          appUpdateResolvedRef.current = true;
          setAppUpdateInfo({ currentVersion: version });
          setAppUpdatePhase("not-available");
          setAppUpdateOpen(true);
        }
        return false;
      }

      return showShellUpdateAvailable(
        {
          version: release.version,
          currentVersion: version,
          releaseNotes: release.releaseNotes,
          releaseDate: release.releaseDate,
          downloadUrl: release.downloadUrl,
          releasePageUrl: release.releasePageUrl,
          mode: "manual",
          webFallback: true,
        },
        { ignoreSnooze: manual }
      );
    } catch (err) {
      if (manual) {
        appUpdateResolvedRef.current = true;
        setAppUpdateBusy(false);
        setAppUpdateError(String(err.message || err));
        setAppUpdateOpen(true);
      }
      return false;
    }
  };

  const handleManualAppUpdateCheck = async () => {
    const companion = window.inspiretechCompanion;
    if (!companion?.checkForUpdates) return;

    appUpdateManualCheckRef.current = true;
    appUpdateResolvedRef.current = false;
    setAppUpdateBusy(false);
    setAppUpdateError("");
    setAppUpdatePhase("checking");
    setAppUpdateInfo({ currentVersion: desktopAppVersion });
    setAppUpdateOpen(true);

    try {
      await companion.checkForUpdates();
    } catch {
      // Errors are surfaced via update events or the web fallback below.
    }

    window.setTimeout(async () => {
      if (appUpdateResolvedRef.current) {
        appUpdateManualCheckRef.current = false;
        return;
      }
      await runWebShellUpdateFallback(desktopAppVersion, { manual: true });
      appUpdateManualCheckRef.current = false;
    }, 1200);
  };

  // Desktop app: check GitHub / electron-updater for a newer shell build.
  useEffect(() => {
    if (!isCompanionApp()) return undefined;
    const companion = window.inspiretechCompanion;
    if (!companion?.onUpdateEvent) return undefined;

    companion.getAppVersion?.().then((version) => {
      if (version) setDesktopAppVersion(String(version));
    });

    const unsubscribe = companion.onUpdateEvent((payload) => {
      if (!payload?.event) return;

      if (payload.event === "checking") {
        setAppUpdateError("");
        return;
      }

      if (payload.event === "available") {
        const ignoreSnooze = appUpdateManualCheckRef.current;
        showShellUpdateAvailable(payload, { ignoreSnooze });
        return;
      }

      if (payload.event === "not-available") {
        if (appUpdateManualCheckRef.current) {
          return;
        }
        appUpdateResolvedRef.current = true;
        void runWebShellUpdateFallback(desktopAppVersion || payload.version);
        return;
      }

      if (payload.event === "progress") {
        appUpdateResolvedRef.current = true;
        setAppUpdatePhase("downloading");
        setAppUpdateProgress(Math.max(0, Math.min(100, Number(payload.percent) || 0)));
        return;
      }

      if (payload.event === "downloaded") {
        appUpdateResolvedRef.current = true;
        setAppUpdatePhase("downloaded");
        setAppUpdateBusy(false);
        setAppUpdateProgress(100);
        return;
      }

      if (payload.event === "error") {
        appUpdateResolvedRef.current = true;
        setAppUpdateBusy(false);
        setAppUpdateError(String(payload.message || "Update check failed"));
        if (appUpdateManualCheckRef.current) {
          setAppUpdateOpen(true);
        }
      }
    });

    companion.checkForUpdates?.().catch(() => {});

    return unsubscribe;
  }, [desktopAppVersion]);

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

  useEffect(() => {
    creditsRef.current = credits;
  }, [credits]);

  useEffect(() => {
    isTrialAccountRef.current = isTrialAccount;
  }, [isTrialAccount]);

  useEffect(() => {
    allowPurchaseRef.current = allowPurchase;
  }, [allowPurchase]);

  // Closing the tab/window without Stop leaves Decart billing your API key while
  // the ledger stops deducting — tear down the full live pipeline on page hide.
  useEffect(() => {
    const cleanupLiveSession = () => {
      if (isRunningRef.current || realtimeClientRef.current || billingSessionIdRef.current) {
        stopTransformationRef.current();
      }
    };

    window.addEventListener("pagehide", cleanupLiveSession);
    window.addEventListener("beforeunload", cleanupLiveSession);
    return () => {
      window.removeEventListener("pagehide", cleanupLiveSession);
      window.removeEventListener("beforeunload", cleanupLiveSession);
    };
  }, []);

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
        drawVideoFrame(ctx, outputVideoRef.current, canvas.width, canvas.height, "cover");
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        window.inspireTechDesktop.sendFrame(imageData.data.buffer);
      }
      desktopCaptureFrameRef.current = requestAnimationFrame(drawFrame);
    };

    const startCapture = async () => {
      const video = outputVideoRef.current;
      if (!video) return;
      const { virtualWidth: width, virtualHeight: height } = getOutputQualityConfig(outputQuality);

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
  }, [isRunning, outputQuality]);

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
    isMobileLayoutRef.current = isMobileLayout;
  }, [isMobileLayout]);

  useEffect(() => {
    if (isMobileLayout && isRunning) {
      setMobileControlsOpen(false);
    } else if (isMobileLayout && !isRunning) {
      setMobileControlsOpen(true);
    }
  }, [isMobileLayout, isRunning]);

  useEffect(() => {
    if (!isMobileWebStudio || !showAddCredits) return;
    setMobileControlsOpen(true);
    const timer = setTimeout(() => {
      creditSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    return () => clearTimeout(timer);
  }, [showAddCredits, isMobileWebStudio]);

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

  const enterOutputTheater = async ({ silent = false, force = false, requireStream = true } = {}) => {
    if (!force && !isRunningRef.current) {
      if (!silent) setStatus("START TRANSFORMATION FIRST — THEN TAP FULL SCREEN");
      return false;
    }
    const video = outputVideoRef.current;
    if (requireStream && !video?.srcObject) {
      if (!silent) setStatus("WAITING FOR VIDEO — TRY AGAIN IN A MOMENT");
      return false;
    }
    if (mobileOutputFocusRef.current) return true;
    setMobileTheaterFocus(true);
    setTheaterControlsVisible(true);
    scheduleTheaterControlsHide();
    try {
      document.documentElement.style.overflow = "hidden";
      document.body.style.overflow = "hidden";
    } catch {
      // ignore
    }
    return true;
  };

  const exitOutputTheater = async () => {
    setMobileTheaterFocus(false);
    setIsPoppedOut(false);
    clearTheaterControlsTimer();
    setTheaterControlsVisible(true);
    try {
      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      if (document.fullscreenElement) await document.exitFullscreen();
      const video = outputVideoRef.current;
      if (video?.webkitDisplayingFullscreen) {
        video.webkitExitFullscreen?.();
      }
    } catch {
      // ignore
    }
  };

  const toggleOutputTheater = async () => {
    if (mobileOutputFocus) {
      await exitOutputTheater();
    } else {
      await enterOutputTheater();
    }
  };

  // Keep alias used elsewhere in this file.
  const exitMobileTheater = exitOutputTheater;

  // Desktop PiP / fullscreen theater handler.
  const handlePopOutVideo = async () => {
    try {
      if (isMobileLayout || !pipSupported) {
        await toggleOutputTheater();
        return;
      }
      if (document.pictureInPictureElement || mobileOutputFocus) {
        await exitOutputTheater();
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
      exitOutputTheater();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);

  // Mobile: auto edge-to-edge output when live (no manual full-screen tap).
  useEffect(() => {
    if (!shouldUseMobileTheater() || !isRunning || mobileOutputFocus) return undefined;
    let cancelled = false;
    const tryAutoTheater = () => {
      if (cancelled || mobileOutputFocusRef.current || !isRunningRef.current) return true;
      void enterOutputTheater({ silent: true, force: true, requireStream: false });
      return mobileOutputFocusRef.current;
    };
    if (tryAutoTheater()) return undefined;
    const interval = setInterval(() => {
      if (tryAutoTheater()) clearInterval(interval);
    }, 200);
    const timeout = setTimeout(() => clearInterval(interval), 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobileLayout, isRunning, mobileOutputFocus]);

  useEffect(() => {
    const video = outputVideoRef.current;
    if (!video) return undefined;
    const onNativeFullscreenBegin = () => {
      nativeVideoFullscreenRef.current = true;
    };
    const onNativeFullscreenEnd = () => {
      if (!nativeVideoFullscreenRef.current) return;
      nativeVideoFullscreenRef.current = false;
      setMobileTheaterFocus(false);
      try {
        document.documentElement.style.overflow = "";
        document.body.style.overflow = "";
      } catch {
        // ignore
      }
    };
    video.addEventListener("webkitbeginfullscreen", onNativeFullscreenBegin);
    video.addEventListener("webkitendfullscreen", onNativeFullscreenEnd);
    return () => {
      video.removeEventListener("webkitbeginfullscreen", onNativeFullscreenBegin);
      video.removeEventListener("webkitendfullscreen", onNativeFullscreenEnd);
    };
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

  useEffect(() => {
    if (!accessToken || !sessionReady || isRunning) return undefined;

    let cancelled = false;
    const probeNetwork = async () => {
      const result = await assessNetworkQuality({ ledgerUrl: LEDGER_URL });
      if (!cancelled) {
        setNetworkQuality(result);
        setNetworkChecked(true);
      }
    };

    probeNetwork();
    const interval = setInterval(probeNetwork, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [accessToken, sessionReady, isRunning]);

  // Voice changer (1,000+) and background changer (2,000+) are tier-gated separately.
  useEffect(() => {
    if (!tierAccessLoaded) return;
    if (!voiceChangerAccess) setVoiceChangerEnabled(false);
    if (!backgroundChangerAccess) setUseReferenceBackground(false);
  }, [voiceChangerAccess, backgroundChangerAccess, tierAccessLoaded]);

  // Load the voice list once, right after the token is accepted.
  useEffect(() => {
    if (!accessToken || !voiceChangerAccess) return;
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
        } else if (res.status === 403 && data.voiceChanger === false) {
          syncTierAccessFromLedger(data);
          setVoiceLoadError(data.error || VOICE_UPGRADE_MESSAGE);
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
  }, [accessToken, voiceChangerAccess]);

  // Load the real-time engine's voice list only when that engine is
  // actually selected (no point minting tickets/hitting voice-rt-server
  // otherwise) — needs a ticket from ledger-backend first, then asks
  // voice-rt-server directly for whatever voice folders are on its volume.
  useEffect(() => {
    if (!accessToken || !voiceChangerAccess || voiceEngine !== "realtime") return;
    setRtcVoicesLoading(true);
    setRtcLoadError("");
    (async () => {
      try {
        const res = await fetch(`${LEDGER_URL}/api/voice/rtc-voices`, { headers: authHeaders() });
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) {
          handleTokenRejected("Your access token was rejected. Please re-enter it.");
          return;
        }
        if (res.status === 403) {
          if (data.voiceChanger === false) {
            syncTierAccessFromLedger(data);
            setRtcLoadError(data.error || VOICE_UPGRADE_MESSAGE);
            return;
          }
          handleTokenRejected(data.error || "Your access has been revoked. If you think this is a mistake, message us on WhatsApp below.");
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
  // Match Decart output quality (incl. 1080p). Feeder stdin is backpressure-safe
  // in companion ≥0.3.24 — do not soft-cap below the reference / output size.
  const COMPANION_LIVE_FPS = 20;
  // Keep idle pushes frequent so Electron-side branding stays on the device;
  // the native feeder also repeats the last frame so Unity never shows yellow.
  const COMPANION_IDLE_FPS = 12;
  const COMPANION_LIVE_FPS_1080 = 15; // slightly lower at Full HD to keep the pipe stable

  const getCompanionVirtualSize = () => {
    const { virtualWidth, virtualHeight } = getOutputQualityConfig(outputQuality);
    return { width: virtualWidth, height: virtualHeight };
  };

  const getCompanionLiveFps = () => {
    const { width, height } = getCompanionVirtualSize();
    return width * height >= 1920 * 1080 ? COMPANION_LIVE_FPS_1080 : COMPANION_LIVE_FPS;
  };

  // Always feed InspireTech Camera: live transform when available, otherwise a blank
  // black frame with the camera name (Unity Capture's idle color is yellowish).
  useEffect(() => {
    if (typeof window === "undefined" || !window.inspiretechCompanion) return;

    const canvas = companionCanvasRef.current || document.createElement("canvas");
    companionCanvasRef.current = canvas;
    const { width, height } = getCompanionVirtualSize();
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let cancelled = false;
    let intervalId = null;
    let lastFps = 0;

    const pushFrame = () => {
      if (cancelled || !window.inspiretechCompanion?.sendFrame) return;
      try {
        const video = outputVideoRef.current;
        if (isRunningRef.current && video?.videoWidth) {
          drawVideoFrame(ctx, video, canvas.width, canvas.height, "cover");
        } else {
          drawIdleVirtualCamFrame(ctx, canvas.width, canvas.height);
        }
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        window.inspiretechCompanion.sendFrame(imageData.data.buffer);
      } catch (err) {
        console.warn("[InspireTech] Virtual camera frame push failed:", err);
      }
    };

    const syncInterval = (force = false) => {
      const fps = isRunningRef.current ? getCompanionLiveFps() : COMPANION_IDLE_FPS;
      if (!force && fps === lastFps && intervalId) return;
      lastFps = fps;
      if (intervalId) clearInterval(intervalId);
      intervalId = setInterval(pushFrame, 1000 / fps);
      companionCaptureIntervalRef.current = intervalId;
    };

    const beginCapture = async () => {
      if (window.inspiretechCompanion.configureVirtualCam) {
        try {
          await window.inspiretechCompanion.configureVirtualCam({ width, height });
        } catch (err) {
          console.warn("[InspireTech] Virtual camera configure failed:", err);
        }
      }
      if (cancelled) return;
      syncInterval(true);
      pushFrame();
    };

    const fpsWatch = setInterval(() => {
      if (!cancelled) syncInterval(false);
    }, 500);

    void beginCapture();

    return () => {
      cancelled = true;
      clearInterval(fpsWatch);
      if (intervalId) clearInterval(intervalId);
      if (companionCaptureIntervalRef.current === intervalId) {
        companionCaptureIntervalRef.current = null;
      }
    };
  }, [outputQuality]);

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

  const syncTierAccessFromLedger = (data) => {
    if (typeof data?.voiceChanger === "boolean" || typeof data?.premiumFeatures === "boolean") {
      setVoiceChangerAccess(Boolean(data.voiceChanger ?? data.premiumFeatures));
    }
    if (typeof data?.backgroundChanger === "boolean") {
      setBackgroundChangerAccess(data.backgroundChanger);
    } else if (typeof data?.voiceChanger === "boolean" || typeof data?.premiumFeatures === "boolean") {
      // Older ledger builds only expose voice tier — keep background locked until redeployed.
      setBackgroundChangerAccess(false);
    }
    if (typeof data?.allowPurchase === "boolean") {
      setAllowPurchase(data.allowPurchase);
    }
    if (typeof data?.isTrial === "boolean") {
      setIsTrialAccount(data.isTrial);
    }
    if (
      typeof data?.voiceChanger === "boolean" ||
      typeof data?.backgroundChanger === "boolean" ||
      typeof data?.premiumFeatures === "boolean" ||
      typeof data?.allowPurchase === "boolean"
    ) {
      setTierAccessLoaded(true);
    }
  };

  const scrollToCreditsSection = () => {
    creditSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    setShowAddCredits(true);
  };

  const runCompanionDriverSetup = async ({
    skipVirtualMic = true,
    forceReinstall = false,
    fromGate = true,
  } = {}) => {
    const companion = window.inspiretechCompanion;
    if (!companion?.getSetupStatus || !companion?.installDrivers) {
      throw new Error(
        "Desktop driver bridge unavailable. Close and reopen InspireTech, or reinstall from the latest Windows installer."
      );
    }

    const status = await companion.getSetupStatus();
    if (!status.unityCaptureBundled) {
      throw new Error(
        "InspireTech Camera driver files are missing from this build. Download the latest installer from inspirestream.xyz."
      );
    }

    // Gate checkbox is the explicit user choice; saved state only applies on background retries.
    const skipAudio = fromGate ? skipVirtualMic : status.skipVirtualAudio;
    const needsCamera = forceReinstall || !status.cameraInstalled;
    const needsAudio =
      status.vbCableBundled && !skipAudio && (forceReinstall || !status.audioInstalled);

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
    if (companion.startVirtualCamFeeder) {
      await companion.startVirtualCamFeeder();
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
      const status = await window.inspiretechCompanion.getSetupStatus();
      syncCompanionDriverStatus(status);
      setStatus("SYSTEM STANDBY");
    } catch (err) {
      setDriverSetupFailed(true);
      setStatus(`DRIVER SETUP FAILED: ${err.message}`);
    } finally {
      setDriverSetupBusy(false);
    }
  };

  const installCompanionVbCable = async ({ forceReinstall = false } = {}) => {
    if (driverSetupBusy || !isCompanionApp()) return;
    const companion = window.inspiretechCompanion;
    if (!companion?.installAudioDriver) {
      setStatus("DRIVER SETUP FAILED: Desktop driver bridge unavailable.");
      return;
    }

    setDriverSetupBusy(true);
    setTokenError("");
    try {
      const before = await companion.getSetupStatus();
      if (!before?.vbCableBundled) {
        throw new Error(
          "VB-CABLE is not bundled in this desktop build. Download the latest InspireTech installer from inspirestream.xyz."
        );
      }

      setStatus(forceReinstall ? "REINSTALLING VB-CABLE — APPROVE UAC" : "INSTALLING VB-CABLE — APPROVE UAC");
      await companion.setSkipAudio?.(false);
      await companion.installAudioDriver({ forceReinstall });
      const status = await companion.getSetupStatus();
      syncCompanionDriverStatus(status);
      if (!status?.audioInstalled) {
        throw new Error(
          "VB-CABLE install did not finish. Approve UAC, complete the VB-CABLE wizard if it opened, then reboot Windows and try again."
        );
      }
      setDriverSetupFailed(false);
      setStatus("SYSTEM STANDBY");
    } catch (err) {
      setDriverSetupFailed(true);
      setStatus(`DRIVER SETUP FAILED: ${err.message}`);
    } finally {
      setDriverSetupBusy(false);
    }
  };

  const reinstallCompanionCamera = async () => {
    if (driverSetupBusy || !isCompanionApp()) return;
    setDriverSetupBusy(true);
    setTokenError("");
    try {
      setStatus("REINSTALLING CAMERA — APPROVE UAC");
      await runCompanionDriverSetup({ forceReinstall: true, fromGate: false, skipVirtualMic: true });
      const status = await window.inspiretechCompanion.getSetupStatus();
      syncCompanionDriverStatus(status);
      setDriverSetupFailed(false);
      setStatus("SYSTEM STANDBY");
    } catch (err) {
      setDriverSetupFailed(true);
      setStatus(`DRIVER SETUP FAILED: ${err.message}`);
    } finally {
      setDriverSetupBusy(false);
    }
  };

  const dismissAppUpdate = (hours = 24) => {
    try {
      window.localStorage.setItem(
        "inspiretech_update_snooze_until",
        String(Date.now() + hours * 60 * 60 * 1000)
      );
    } catch {
      // ignore
    }
    setAppUpdateOpen(false);
    setAppUpdateBusy(false);
  };

  const startAppUpdateDownload = async () => {
    const companion = window.inspiretechCompanion;
    if (appUpdateInfo?.webFallback && appUpdateInfo?.downloadUrl) {
      setAppUpdateBusy(true);
      setAppUpdateError("");
      setAppUpdatePhase("downloading");
      try {
        window.open(appUpdateInfo.downloadUrl, "_blank", "noopener,noreferrer");
        setAppUpdatePhase("downloaded");
        setAppUpdateBusy(false);
      } catch (err) {
        setAppUpdateBusy(false);
        setAppUpdatePhase("available");
        setAppUpdateError(String(err.message || err));
      }
      return;
    }
    if (!companion?.downloadUpdate) return;
    setAppUpdateBusy(true);
    setAppUpdateError("");
    setAppUpdatePhase("downloading");
    try {
      await companion.downloadUpdate();
    } catch (err) {
      setAppUpdateBusy(false);
      setAppUpdatePhase("available");
      setAppUpdateError(String(err.message || err));
    }
  };

  const restartForAppUpdate = async () => {
    try {
      await window.inspiretechCompanion?.installUpdate?.();
    } catch (err) {
      setAppUpdateError(String(err.message || err));
    }
  };

  const renderAppUpdateModal = () => {
    if (!isCompanionApp() || !appUpdateOpen) return null;

    if (appUpdatePhase === "checking") {
      const currentVersion = appUpdateInfo?.currentVersion || desktopAppVersion || "…";
      return (
        <div className="itc-update-overlay" role="dialog" aria-modal="true" aria-labelledby="itc-update-title">
          <div className="itc-update-modal">
            <h2 id="itc-update-title" className="itc-update-title">Checking for updates…</h2>
            <p className="itc-update-copy">
              Looking for a newer InspireTech desktop build. You&apos;re currently on v{currentVersion}.
            </p>
            {appUpdateError && <div className="itc-update-error">{appUpdateError}</div>}
            <div className="itc-update-actions">
              <button type="button" className="itc-btn itc-btn-secondary" disabled>
                Checking…
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (appUpdatePhase === "not-available") {
      const currentVersion = appUpdateInfo?.currentVersion || desktopAppVersion || "unknown";
      return (
        <div className="itc-update-overlay" role="dialog" aria-modal="true" aria-labelledby="itc-update-title">
          <div className="itc-update-modal">
            <h2 id="itc-update-title" className="itc-update-title">You&apos;re up to date</h2>
            <p className="itc-update-copy">
              InspireTech v{currentVersion} is the latest desktop build available.
            </p>
            {appUpdateError && <div className="itc-update-error">{appUpdateError}</div>}
            <div className="itc-update-actions">
              <button
                type="button"
                className="itc-btn itc-btn-primary"
                onClick={() => setAppUpdateOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (!appUpdateInfo) return null;

    const currentVersion = appUpdateInfo.currentVersion || desktopAppVersion || "unknown";
    const nextVersion = appUpdateInfo.version || "latest";
    const isManual = appUpdateInfo.mode === "manual";
    const title =
      appUpdatePhase === "downloaded"
        ? isManual
          ? "Installer launched"
          : "Update ready to install"
        : appUpdatePhase === "downloading"
        ? "Downloading update…"
        : "Update available";

    return (
      <div className="itc-update-overlay" role="dialog" aria-modal="true" aria-labelledby="itc-update-title">
        <div className="itc-update-modal">
          <h2 id="itc-update-title" className="itc-update-title">{title}</h2>
          <p className="itc-update-copy">
            {appUpdatePhase === "downloaded" && isManual
              ? "Follow the installer window to finish updating InspireTech. This app will close so the new version can install."
              : appUpdatePhase === "downloaded"
              ? `InspireTech ${nextVersion} has been downloaded. Restart to apply driver, shell, and desktop feature updates.`
              : appUpdatePhase === "downloading"
              ? `Downloading InspireTech ${nextVersion}. Keep this window open until the download finishes.`
              : `You're on v${currentVersion}. InspireTech ${nextVersion} is available with the latest desktop features and fixes. Update now, or decline to stay on this version.`}
          </p>

          {appUpdatePhase === "downloading" && (
            <div className="itc-update-progress-wrap">
              <div className="itc-update-progress-bar">
                <div
                  className="itc-update-progress-fill"
                  style={{ width: `${Math.round(appUpdateProgress)}%` }}
                />
              </div>
              <span className="itc-update-progress-label">{Math.round(appUpdateProgress)}%</span>
            </div>
          )}

          {appUpdateError && <div className="itc-update-error">{appUpdateError}</div>}

          <div className="itc-update-actions">
            {appUpdatePhase === "available" && (
              <>
                <button
                  type="button"
                  className="itc-btn itc-btn-primary"
                  disabled={appUpdateBusy}
                  onClick={startAppUpdateDownload}
                >
                  {isManual ? "Update now" : "Update now"}
                </button>
                <button
                  type="button"
                  className="itc-btn itc-btn-secondary"
                  disabled={appUpdateBusy}
                  onClick={() => dismissAppUpdate()}
                >
                  Decline
                </button>
              </>
            )}
            {appUpdatePhase === "downloading" && (
              <button type="button" className="itc-btn itc-btn-secondary" disabled>
                Downloading…
              </button>
            )}
            {appUpdatePhase === "downloaded" && !isManual && (
              <>
                <button type="button" className="itc-btn itc-btn-primary" onClick={restartForAppUpdate}>
                  Restart now
                </button>
                <button type="button" className="itc-btn itc-btn-secondary" onClick={() => dismissAppUpdate(1)}>
                  Restart later
                </button>
              </>
            )}
            {appUpdatePhase === "downloaded" && isManual && (
              <button type="button" className="itc-btn itc-btn-secondary" onClick={() => setAppUpdateOpen(false)}>
                Close
              </button>
            )}
          </div>
        </div>
      </div>
    );
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
        if (window.inspiretechCompanion?.setSkipAudio) {
          await window.inspiretechCompanion.setSkipAudio(Boolean(options.skipVirtualMic ?? true));
        }
        await runCompanionDriverSetup({ ...options, forceReinstall: false, fromGate: true });
        if (window.inspiretechCompanion?.startVirtualCamFeeder) {
          await window.inspiretechCompanion.startVirtualCamFeeder();
        }
      }

      saveAccessToken(normalized);
      gateJustAuthenticatedRef.current = true;
      accessCheckPausedRef.current = false;
      setSessionReady(true);
      setCredits(validation.credits);
      setCreditsLoaded(true);
      syncTierAccessFromLedger(validation);
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
    if (billingSessionIdRef.current || isRunningRef.current) return;
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
      syncTierAccessFromLedger(data);
      setCreditsLoaded(true);
      setLedgerUnreachable(false);
    } catch (err) {
      console.error("Could not reach ledger backend:", err);
      setLedgerUnreachable(true);
    }
  };

  // Note: verify-on-return intentionally does NOT send the token header — the
  // backend recovers it from the Flutterwave transaction meta instead,
  // since this fires right after a browser redirect (no custom headers there).
  const verifyPurchase = async (reference, transactionId) => {
    try {
      const query = transactionId ? `?transaction_id=${encodeURIComponent(transactionId)}` : "";
      const res = await fetch(`${LEDGER_URL}/api/verify/${encodeURIComponent(reference)}${query}`);
      const data = await res.json();
      if (!res.ok) {
        setStatus(`PAYMENT VERIFICATION FAILED: ${data.error || "unknown error"}`);
        return;
      }
      setCredits(data.credits);
      syncTierAccessFromLedger(data);
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
      setElapsedSeconds((prev) => {
        const next = prev + 1;
        const cap = Number(trialSessionCapRef.current) || 0;
        if (cap > 0 && next >= cap) {
          queueMicrotask(() => {
            if (!isRunningRef.current) return;
            stopTransformationRef.current();
            setStatus("TRIAL ENDED — MESSAGE WHATSAPP TO PURCHASE");
            setShowAddCredits(true);
          });
        }
        return next;
      });
    }, 1000);
  };

  const clearClockTimer = () => {
    if (clockTimerRef.current) {
      clearInterval(clockTimerRef.current);
      clockTimerRef.current = null;
    }
  };

  const clearBillingOpenFallback = () => {
    if (billingOpenFallbackRef.current) {
      clearTimeout(billingOpenFallbackRef.current);
      billingOpenFallbackRef.current = null;
    }
  };

  const waitForBillingEnd = async () => {
    if (!billingEndInFlightRef.current) return;
    await billingEndInFlightRef.current.catch(() => {});
  };

  // Opens a server billing session and starts the elapsed clock + heartbeat.
  // Called on the first Decart generationTick — connect/handshake time is not billed.
  const beginBillingSession = async (decartBaselineSeconds = 0) => {
    const decartBaseline = Math.max(0, Number(decartBaselineSeconds) || 0);
    try {
      const res = await fetch(`${LEDGER_URL}/api/sessions/start`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: getClientId(),
          platform: getClientPlatform(),
          decartBaselineSeconds: decartBaseline,
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
        setStatus(
          (isTrialAccountRef.current && !allowPurchaseRef.current) || data.isTrial
            ? "TRIAL ENDED — MESSAGE WHATSAPP TO PURCHASE"
            : "OUT OF CREDITS — ADD MORE TO CONTINUE"
        );
        setShowAddCredits(true);
        return false;
      }
      billingSessionIdRef.current = data.sessionId;
      billingCreditsStartRef.current = data.credits;
      heartbeatFailCountRef.current = 0;
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

  const ensureBillingForGeneration = async (decartSeconds) => {
    if (billingSessionIdRef.current || billingStartInFlightRef.current) return;
    billingStartInFlightRef.current = true;
    try {
      const ok = await beginBillingSession(decartSeconds);
      if (!ok) {
        stopTransformation();
        return;
      }
      decartSecondsAtBillingStartRef.current = decartSeconds;
      setStatus("COMPUTE LINK ONLINE // REALTIME TRANSFORMATION TERMINAL");
    } finally {
      billingStartInFlightRef.current = false;
    }
  };

  // The REAL billing loop — every tick asks the server "how much do I have
  // left now", and the server is the one doing the math and the deduction.
  const startHeartbeat = (sessionId) => {
    clearHeartbeat();
    setSessionCreditsUsed(0);
    sessionCreditsUsedRef.current = 0;
    const startedAtCredits = creditsRef.current;

    const scheduleNext = () => {
      heartbeatTimerRef.current = setTimeout(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    };

    const sendHeartbeat = async () => {
      if (billingSessionIdRef.current !== sessionId) return;
      if (heartbeatInFlightRef.current) return;
      heartbeatInFlightRef.current = true;
      try {
        const res = await fetch(`${LEDGER_URL}/api/sessions/${sessionId}/heartbeat`, {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            clientId: getClientId(),
            platform: getClientPlatform(),
            decartGenerationSeconds: decartGenerationSecondsRef.current,
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
        heartbeatFailCountRef.current = 0;
        const data = await res.json();
        setCredits(data.credits);
        const used = Math.max(0, startedAtCredits - data.credits);
        sessionCreditsUsedRef.current = used;
        setSessionCreditsUsed(used);

        if (data.depleted) {
          clearHeartbeat();
          stopTransformation();
          setStatus(
            isTrialAccountRef.current && !allowPurchaseRef.current
              ? "TRIAL ENDED — MESSAGE WHATSAPP TO PURCHASE"
              : "OUT OF CREDITS — ADD MORE TO CONTINUE"
          );
          setShowAddCredits(true);
        }
      } catch (err) {
        console.error("Heartbeat error:", err);
        heartbeatFailCountRef.current += 1;
        if (heartbeatFailCountRef.current >= 3) {
          setStatus("LEDGER UNREACHABLE — STOPPING LIVE SESSION");
          stopTransformation();
        }
      } finally {
        heartbeatInFlightRef.current = false;
        if (billingSessionIdRef.current === sessionId) scheduleNext();
      }
    };

    void sendHeartbeat();
  };

  const clearHeartbeat = () => {
    if (heartbeatTimerRef.current) {
      clearTimeout(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    heartbeatInFlightRef.current = false;
  };

  const formatTime = (totalSeconds) => {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, "0");
    const s = (totalSeconds % 60).toString().padStart(2, "0");
    return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
  };

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
      applyStableVideoTrackSettings(videoTrack);
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
      setMirrorLocalPreview(resolveLocalPreviewMirror(stream));

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

  const handleMobileMicEnabledChange = async (enabled) => {
    setMobileMicEnabled(enabled);
    try {
      window.localStorage.setItem("inspiretech_mobile_mic", enabled ? "1" : "0");
    } catch {
      // ignore storage failures
    }
    if (isRunning) return;
    if (cameraActive) {
      await startCamera(selectedVideoDeviceIdRef.current);
    }
  };

  const invalidateReferenceCache = () => {
    referenceUploadGenerationRef.current += 1;
    referenceImageRefId.current = null;
    referenceBoundToFileRef.current = null;
    referenceImageSourceRef.current = null;
    preparedReferenceFileRef.current = null;
    decartPrewarmRef.current.uploadPromise = null;
    sceneCompositeCacheRef.current.clear();
  };

  const referenceCacheMatchesCurrentFile = () =>
    Boolean(selectedFile && referenceBoundToFileRef.current === selectedFile && referenceImageRefId.current);

  const handleFileChange = (file) => {
    if (!file) return;
    invalidateReferenceCache();
    referenceImageSourceRef.current = file;
    setSelectedFile(file);
    if (imagePreviewUrlRef.current) {
      URL.revokeObjectURL(imagePreviewUrlRef.current);
    }
    const previewUrl = URL.createObjectURL(file);
    imagePreviewUrlRef.current = previewUrl;
    setImagePreview(previewUrl);
    setStatus("PAYLOAD READY FOR TRANSMISSION");
    void prewarmReferenceImageUpload(file);
  };

  const getPromptComposeOptions = () => ({
    useReferenceBackground: backgroundChangerAccess && useReferenceBackground && Boolean(selectedFile),
  });

  const getPromptText = () => {
    if (backgroundChangerAccess && useReferenceBackground && selectedFile) return "";
    const text = transformationPrompt.trim() || DEFAULT_TRANSFORMATION_PROMPT;
    if (!backgroundChangerAccess && hasBackgroundIntent(text)) return DEFAULT_TRANSFORMATION_PROMPT;
    return text;
  };

  const getDecartPrompt = () =>
    composeTransformationPrompt(getPromptText(), Boolean(selectedFile), getPromptComposeOptions());

  const getDecartEnhance = (sourcePrompt = getPromptText()) => {
    const composeOptions = getPromptComposeOptions();
    if (composeOptions.useReferenceBackground) return true;
    return shouldEnhanceDecartPrompt(sourcePrompt, enhanceMask);
  };

  const ensureDecartApiKey = async ({ forceRefresh = false } = {}) => {
    const now = Date.now();
    const cached = decartPrewarmRef.current;
    const expiresAtMs = cached.expiresAt ? Date.parse(cached.expiresAt) : NaN;
    const notExpired =
      !Number.isFinite(expiresAtMs) || now < expiresAtMs - 20_000; // refresh 20s before Decart expiry
    if (
      !forceRefresh &&
      cached.apiKey &&
      now - cached.fetchedAt < DECART_PREWARM_TTL_MS &&
      notExpired
    ) {
      return cached.apiKey;
    }
    const auth = await fetchDecartRealtimeCredentials(getModelId());
    if (!auth?.apiKey) return null;
    decartPrewarmRef.current = {
      ...decartPrewarmRef.current,
      apiKey: auth.apiKey,
      fetchedAt: now,
      expiresAt: auth.expiresAt || null,
    };
    const trialCapFromLedger = Number(auth.maxSessionDuration);
    trialSessionCapRef.current =
      auth.isTrial || (isTrialAccountRef.current && !allowPurchaseRef.current)
        ? Math.max(10, Math.min(TRIAL_MAX_SESSION_SECONDS, Number.isFinite(trialCapFromLedger) ? trialCapFromLedger : TRIAL_MAX_SESSION_SECONDS))
        : 0;
    return auth.apiKey;
  };

  const clearDecartApiKeyCache = () => {
    decartPrewarmRef.current = {
      ...decartPrewarmRef.current,
      apiKey: null,
      fetchedAt: 0,
      expiresAt: null,
    };
  };

  const getReferenceUploadFile = async (fileOverride) => {
    const sourceFile = fileOverride ?? selectedFile;
    if (!sourceFile) return null;
    if (
      preparedReferenceFileRef.current &&
      preparedReferenceFileRef.current.source === sourceFile
    ) {
      return preparedReferenceFileRef.current.file;
    }
    const prepareGeneration = referenceUploadGenerationRef.current;
    const prepared = await prepareReferenceImageForUpload(sourceFile);
    if (prepareGeneration !== referenceUploadGenerationRef.current) return prepared;
    preparedReferenceFileRef.current = { source: sourceFile, file: prepared };
    return prepared;
  };

  const resolveReferenceImage = async (client, fileOverride) => {
    const sourceFile = fileOverride ?? selectedFile;
    if (!sourceFile) return null;
    const uploadGeneration = referenceUploadGenerationRef.current;
    const uploadFile = await getReferenceUploadFile(sourceFile);
    if (uploadGeneration !== referenceUploadGenerationRef.current) {
      return uploadFile;
    }

    if (
      referenceImageRefId.current &&
      referenceBoundToFileRef.current === sourceFile
    ) {
      return referenceImageRefId.current;
    }

    try {
      const uploaded = await client.files.upload(uploadFile, { ttlSeconds: "persistent" });
      if (uploadGeneration !== referenceUploadGenerationRef.current) {
        return uploadFile;
      }
      referenceImageRefId.current = uploaded.id;
      referenceBoundToFileRef.current = sourceFile;
      referenceImageSourceRef.current = uploadFile;
      return uploaded.id;
    } catch (err) {
      console.warn("[InspireTech] Reference image upload failed — using inline bytes", err);
      return uploadFile;
    }
  };

  const prewarmReferenceImageUpload = async (fileOverride) => {
    const sourceFile = fileOverride ?? selectedFile;
    if (!sourceFile || !accessToken || ledgerUnreachable) return;
    if (referenceCacheMatchesCurrentFile() && referenceBoundToFileRef.current === sourceFile) return;
    if (decartPrewarmRef.current.uploadPromise) return decartPrewarmRef.current.uploadPromise;
    const run = async () => {
      const apiKey = await ensureDecartApiKey();
      if (!apiKey || !sourceFile) return;
      if (referenceBoundToFileRef.current === sourceFile && referenceImageRefId.current) return;
      const client = createDecartClient({ apiKey });
      await resolveReferenceImage(client, sourceFile);
    };
    decartPrewarmRef.current.uploadPromise = run();
    try {
      await decartPrewarmRef.current.uploadPromise;
    } catch (err) {
      console.warn("[InspireTech] Reference prewarm failed:", err);
    } finally {
      decartPrewarmRef.current.uploadPromise = null;
    }
  };

  const fetchSceneImageFile = async (scene) => {
    if (!scene?.image) throw new Error("Scene has no preview image");
    const response = await fetch(scene.image);
    if (!response.ok) {
      throw new Error(`Could not load scene image (${response.status})`);
    }
    const blob = await response.blob();
    return new File([blob], `${scene.id}.jpg`, { type: blob.type || "image/jpeg" });
  };

  const resolveSceneCompositeReference = async (client, scene) => {
    if (!scene?.id || !scene?.image || !selectedFile) return null;

    const characterFile = await getReferenceUploadFile(selectedFile);
    const cacheKey = `${scene.id}|${selectedFile.name}|${selectedFile.size}|${selectedFile.lastModified}`;
    const cached = sceneCompositeCacheRef.current.get(cacheKey);
    if (cached?.fileId) return cached.fileId;

    const sceneFile = await fetchSceneImageFile(scene);
    const compositeFile = await composeSceneReferenceImage(sceneFile, characterFile);

    try {
      const uploaded = await client.files.upload(compositeFile, { ttlSeconds: "persistent" });
      sceneCompositeCacheRef.current.set(cacheKey, { fileId: uploaded.id, uploadedAt: Date.now() });
      return uploaded.id;
    } catch (err) {
      console.warn("[InspireTech] Scene composite upload failed — using inline bytes", err);
      return compositeFile;
    }
  };

  const ensureReferenceImagePayload = async (client) => {
    if (!selectedFile) return null;
    if (referenceCacheMatchesCurrentFile() && referenceImageRefId.current) {
      return referenceImageRefId.current;
    }
    return resolveReferenceImage(client, selectedFile);
  };

  const getDecartClientForPush = async () => {
    const apiKey = await ensureDecartApiKey();
    if (!apiKey) throw new Error("Could not reach Decart");
    return createDecartClient({ apiKey });
  };

  const pushDecartState = async (
    session,
    sourcePrompt,
    { force = false, rapid = false, scene = null, useSceneReference = false } = {}
  ) => {
    if (!session?.isConnected?.()) return;

    const hasRef = Boolean(selectedFile);
    const composeOptions = getPromptComposeOptions();
    const sceneReferenceMode = Boolean(
      useSceneReference && scene?.id && !composeOptions.useReferenceBackground && hasRef
    );
    const referenceBackgroundMode = Boolean(composeOptions.useReferenceBackground && hasRef);

    // Scene composite has person + room — use the same layered prompt as reference photo background.
    const promptText = sceneReferenceMode
      ? composeSceneLibraryPrompt()
      : composeTransformationPrompt(sourcePrompt, hasRef, composeOptions);
    const useEnhance =
      sceneReferenceMode || referenceBackgroundMode ? true : getDecartEnhance(sourcePrompt);

    const client = await getDecartClientForPush();
    let imagePayload = null;
    if (sceneReferenceMode) {
      imagePayload = await resolveSceneCompositeReference(client, scene);
      if (!imagePayload) throw new Error("Could not build scene + character reference");
    } else if (hasRef) {
      imagePayload = await ensureReferenceImagePayload(client);
      if (!imagePayload) throw new Error("Could not load character reference image");
    }

    const setKey = `${promptText}|${Boolean(imagePayload)}|${useEnhance}|refBg:${referenceBackgroundMode}|scene:${scene?.id || ""}|sceneRef:${sceneReferenceMode}`;
    const now = Date.now();
    const dedupWindow = rapid ? DECART_PRESET_DEDUP_MS : 4000;

    if (!force) {
      if (decartSetGuardRef.current.inFlight) {
        console.info("[InspireTech] Decart set skipped (already in flight)");
        return;
      }
      if (
        decartSetGuardRef.current.lastKey === setKey &&
        now - decartSetGuardRef.current.lastAt < dedupWindow
      ) {
        console.info("[InspireTech] Decart set skipped (duplicate within window)");
        return;
      }
    }

    decartSetGuardRef.current.inFlight = true;
    console.info("[InspireTech] Decart set →", {
      promptText: promptText.slice(0, 180) + (promptText.length > 180 ? "…" : ""),
      enhance: useEnhance,
      hasImage: Boolean(imagePayload),
      referenceBackgroundMode,
      sceneReferenceMode,
      sceneId: scene?.id,
      force,
    });

    try {
      // Decart set() replaces the entire state — always include image when we have one or it gets cleared (fade).
      await session.set({
        prompt: promptText,
        enhance: useEnhance,
        ...(imagePayload ? { image: imagePayload } : {}),
      });
      decartSetGuardRef.current.lastKey = setKey;
      decartSetGuardRef.current.lastAt = Date.now();
    } finally {
      decartSetGuardRef.current.inFlight = false;
    }
  };

  const needsSceneBackground = (sourcePrompt = getPromptText()) =>
    backgroundChangerAccess &&
    Boolean(selectedFile) &&
    (getPromptComposeOptions().useReferenceBackground || hasBackgroundIntent(sourcePrompt));

  const reapplyDecartScene = async (session, sourcePrompt) => {
    if (!session?.isConnected?.()) return;
    const sceneId = activeSceneImageIdRef.current;
    const scene = sceneId ? findBackgroundScene(sceneId) : null;
    if (scene) {
      await pushDecartState(session, sourcePrompt, {
        force: true,
        scene,
        useSceneReference: true,
      });
      return;
    }
    if (!sourcePrompt && !activeSceneUseRefBackgroundRef.current) return;
    await pushDecartState(session, sourcePrompt, { force: true });
  };

  const wireDecartSession = (session) => {
    let lastState = session.getConnectionState?.() || "connecting";

    session.on("error", (err) => {
      // Non-fatal SDK/server errors during prompt updates should not tear down a recoverable session.
      console.error("[InspireTech] Decart session error:", err);
      setPromptApplyNote(err?.message || "Decart warning — retry Apply if output looks wrong.");
    });

    session.on("generationTick", ({ seconds }) => {
      if (!isRunningRef.current) {
        console.warn("[InspireTech] Decart still generating while not live — stopping");
        stopTransformationRef.current();
        return;
      }

      decartGenerationSecondsRef.current = seconds;
      // Do not open billing until transform video is actually on screen —
      // generationTick can fire during handshake while output is still blank.
      if (!transformOutputReadyRef.current) return;
      void ensureBillingForGeneration(seconds);

      if (!billingSessionIdRef.current) return;

      const billableDecartSeconds = Math.max(0, seconds - decartSecondsAtBillingStartRef.current);
      const ledgerSeconds = sessionCreditsUsedRef.current / EFFECTIVE_CREDITS_PER_SECOND;
      // Ledger bills ~39% above Decart API cost — stop immediately if Decart runs ahead.
      if (billableDecartSeconds > ledgerSeconds + 8) {
        console.warn(
          `[InspireTech] Decart generation (${billableDecartSeconds.toFixed(0)}s billable) ahead of ledger (~${ledgerSeconds.toFixed(0)}s) — stopping`
        );
        setStatus("BILLING SYNC LOST — LIVE SESSION STOPPED");
        stopTransformation();
      }
    });

    session.on("connectionChange", (state) => {
      const prev = lastState;
      lastState = state;

      if (state === "connecting") {
        setStatus("HANDSHAKING WITH DECART WEBRTC CLUSTER...");
        return;
      }

      if (state === "connected" && !transformOutputReadyRef.current) {
        setStatus("CONNECTED — WAITING FOR TRANSFORM…");
      }

      if (state === "generating" && !billingSessionIdRef.current) {
        setStatus("GENERATING TRANSFORM…");
      }

      if (state === "reconnecting") {
        setStatus("DECART RECONNECTING…");
        return;
      }

      if (
        (state === "connected" || state === "generating") &&
        prev === "reconnecting"
      ) {
        const scenePrompt = activeScenePromptRef.current;
        const now = Date.now();
        if (
          realtimeClientRef.current === session &&
          (scenePrompt || activeSceneUseRefBackgroundRef.current || activeSceneImageIdRef.current) &&
          now - decartSetGuardRef.current.reconnectAt >= 8000
        ) {
          decartSetGuardRef.current.reconnectAt = now;
          void reapplyDecartScene(session, scenePrompt).catch((err) => {
            console.warn("[InspireTech] Scene reapply after reconnect failed:", err);
          });
        }
        return;
      }

      if (state !== "disconnected") return;
      if (realtimeClientRef.current !== session) return;
      handleDecartSessionFault(new Error("Decart session disconnected"), "Decart disconnected");
    });
  };

  const handleDecartSessionFault = (err, label = "Decart session error") => {
    console.error(label, err);
    setStatus(`CRITICAL FAULT: ${err?.message || label}`);
    setRunningState(false);
    clearClockTimer();
    clearHeartbeat();
    clearBillingOpenFallback();
    transformOutputReadyRef.current = false;
    const decartSession = realtimeClientRef.current;
    realtimeClientRef.current = null;
    if (decartSession) {
      try {
        decartSession.disconnect();
      } catch {
        // ignore
      }
    }
    const sid = billingSessionIdRef.current;
    billingSessionIdRef.current = null;
    billingCreditsStartRef.current = 0;
    decartGenerationSecondsRef.current = 0;
    decartSecondsAtBillingStartRef.current = 0;
    billingStartInFlightRef.current = false;
    endBillingSession(sid);
    stopActiveVoicePipeline();
  };

  const applyBackgroundScene = async (scene) => {
    if (!scene?.prompt) return;
    if (!selectedFile) {
      setPromptApplyNote("Upload a reference photo first — scenes combine your character with the preset room.");
      return;
    }

    setUseReferenceBackground(false);
    setActiveBackgroundSceneId(scene.id);
    setApplyingSceneId(scene.id);
    setSceneTransitionActive(true);
    setTransformationPrompt(scene.prompt);
    setPromptApplyNote("");
    setBackgroundUpdatedNote("");

    const finishTransition = () => {
      setApplyingSceneId("");
      setTimeout(() => setSceneTransitionActive(false), 320);
    };

    const session = realtimeClientRef.current;
    if (session?.isConnected?.()) {
      setPromptApplyBusy(true);
      try {
        activeScenePromptRef.current = scene.prompt;
        activeSceneUseRefBackgroundRef.current = false;
        activeSceneImageIdRef.current = scene.id;
        await pushDecartState(session, "", {
          force: true,
          rapid: true,
          scene,
          useSceneReference: true,
        });
        setBackgroundUpdatedNote("Background updated");
        setPromptApplyNote(`${scene.label} — character + scene room applied like reference photo background.`);
        setStatus("SCENE UPDATED // LIVE TRANSFORMATION");
        setTimeout(() => setBackgroundUpdatedNote(""), 3200);
      } catch (err) {
        console.error("Failed to apply background scene:", err);
        setPromptApplyNote(err?.message || "Could not switch scene.");
        setActiveBackgroundSceneId("");
        activeSceneImageIdRef.current = "";
      } finally {
        setPromptApplyBusy(false);
        setTimeout(finishTransition, SCENE_APPLY_TARGET_MS);
      }
    } else {
      activeSceneImageIdRef.current = scene.id;
      setPromptApplyNote(`${scene.label} selected — scene photo applies when you go live.`);
      void (async () => {
        try {
          const client = await getDecartClientForPush();
          await resolveSceneCompositeReference(client, scene);
        } catch (err) {
          console.warn("[InspireTech] Scene prewarm failed:", err);
        }
      })();
      setTimeout(finishTransition, 480);
    }
  };

  const applyTransformationPrompt = async (promptOverride) => {
    const sourcePrompt = promptOverride ?? getPromptText();
    const session = realtimeClientRef.current;
    const composeOptions = getPromptComposeOptions();
    const wantsBackground =
      Boolean(selectedFile) &&
      (composeOptions.useReferenceBackground || hasBackgroundIntent(sourcePrompt));

    if (!backgroundChangerAccess && wantsBackground) {
      setPromptApplyNote(BACKGROUND_UPGRADE_MESSAGE);
      return;
    }

    if (!session?.isConnected?.()) {
      setPromptApplyNote("Saved — this prompt will apply when you start transformation.");
      return;
    }

    setPromptApplyBusy(true);
    setPromptApplyNote("");
    try {
      activeScenePromptRef.current = sourcePrompt;
      activeSceneUseRefBackgroundRef.current = composeOptions.useReferenceBackground;
      const activeScene = activeSceneImageIdRef.current
        ? findBackgroundScene(activeSceneImageIdRef.current)
        : null;
      if (activeScene && !composeOptions.useReferenceBackground) {
        await pushDecartState(session, sourcePrompt, {
          force: true,
          scene: activeScene,
          useSceneReference: true,
        });
      } else {
        await pushDecartState(session, sourcePrompt, { force: true });
      }
      setPromptApplyNote("Prompt applied to the live stream.");
      setStatus("PROMPT UPDATED // LIVE TRANSFORMATION");
    } catch (err) {
      console.error("Failed to apply prompt:", err);
      setPromptApplyNote(err?.message || "Could not apply prompt.");
    } finally {
      setPromptApplyBusy(false);
    }
  };

  const handleCustomPromptChange = (value) => {
    setTransformationPrompt(value);
    setActiveBackgroundSceneId("");
    activeSceneImageIdRef.current = "";
    if (promptApplyNote) setPromptApplyNote("");
  };

  const fetchDecartRealtimeCredentials = async (modelId) => {
    try {
      const res = await fetch(`${LEDGER_URL}/api/decart/realtime-token`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        handleTokenRejected("Your access token was rejected. Please re-enter it.");
        return null;
      }
      if (res.status === 403) {
        handleTokenRejected(
          await readRejectedMessage(
            res,
            "Your access has been revoked. If you think this is a mistake, message us on WhatsApp below."
          )
        );
        return null;
      }
      if (res.status === 402) {
        setCredits(data.credits ?? 0);
        setStatus(
          isTrialAccountRef.current && !allowPurchaseRef.current
            ? "TRIAL ENDED — MESSAGE WHATSAPP TO PURCHASE"
            : "OUT OF CREDITS — ADD MORE TO CONTINUE"
        );
        setShowAddCredits(true);
        return null;
      }
      if (!res.ok) {
        throw new Error(data.error || `Decart token request failed (${res.status})`);
      }
      return data;
    } catch (err) {
      const message = String(err?.message || err || "");
      const ledgerUnreachable =
        err instanceof TypeError ||
        /failed to fetch|networkerror|fetch failed|load failed/i.test(message);
      if (MY_DECART_KEY && import.meta.env.DEV && ledgerUnreachable) {
        console.warn("[InspireTech] Ledger unreachable in dev — trying VITE_DECART_API_KEY fallback");
        return { apiKey: MY_DECART_KEY, fallback: true };
      }
      throw err;
    }
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
    if (networkChecked && networkQuality.level === NETWORK_QUALITY.POOR) {
      setStatus("WEAK NETWORK — FIX CONNECTION BEFORE STARTING");
      startInProgressRef.current = false;
      return;
    }

    await waitForBillingEnd();

    // Always refresh balance before go-live so the UI isn't stale after a prior session/orphan close.
    try {
      const res = await fetch(`${LEDGER_URL}/api/access-check`, { headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
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
      syncTierAccessFromLedger(data);
      setCredits(data.credits ?? 0);
      if ((data.credits ?? 0) <= 0) {
        setStatus(
          (data.isTrial || isTrialAccountRef.current) && !allowPurchaseRef.current
            ? "TRIAL ENDED — MESSAGE WHATSAPP TO PURCHASE"
            : "OUT OF CREDITS — ADD MORE TO CONTINUE"
        );
        setShowAddCredits(true);
        startInProgressRef.current = false;
        return;
      }
    } catch (err) {
      console.error("Failed to verify credits before start:", err);
      setStatus("LEDGER BACKEND UNREACHABLE — CHECK IT'S RUNNING");
      setLedgerUnreachable(true);
      startInProgressRef.current = false;
      return;
    }

    billingSessionIdRef.current = null;
    transformOutputReadyRef.current = false;
    trialSessionCapRef.current =
      isTrialAccountRef.current && !allowPurchaseRef.current ? TRIAL_MAX_SESSION_SECONDS : 0;
    setRunningState(true);
    setStatus("HANDSHAKING WITH DECART WEBRTC CLUSTER...");

    try {
      let apiKey = await ensureDecartApiKey({ forceRefresh: true });
      if (!apiKey) {
        setRunningState(false);
        return;
      }

      const connectWithKey = async (key) => {
        const client = createDecartClient({ apiKey: key });
        const realtimeModel = getRealtimeModel();
        const sourcePrompt = getPromptText();
        const composeOptions = getPromptComposeOptions();
        const pendingScene = activeBackgroundSceneId ? findBackgroundScene(activeBackgroundSceneId) : null;
        const sceneReferenceAtStart = Boolean(
          pendingScene && !composeOptions.useReferenceBackground && selectedFile
        );
        const referenceBackgroundAtStart = Boolean(composeOptions.useReferenceBackground && selectedFile);

        // Scene mode: connect with composite (character + room) + same layered prompt as reference photo background.
        const connectPrompt =
          referenceBackgroundAtStart || sceneReferenceAtStart
            ? composeLayeredPrompt("", true, { useReferenceBackground: true })
            : CHARACTER_WITH_REF_PROMPT;

        const voiceAllowedNow = voiceChangerAccess && voiceChangerEnabled;
        const hasValidVoiceNow =
          voiceAllowedNow &&
          (voiceEngine === "realtime" ? !!rtcSelectedVoiceId : !!selectedVoiceId);
        const referenceImagePromise = selectedFile
          ? sceneReferenceAtStart
            ? resolveSceneCompositeReference(client, pendingScene)
            : resolveReferenceImage(client, selectedFile)
          : Promise.resolve(null);
        const voicePromise =
          hasValidVoiceNow && voiceEngine === "realtime"
            ? startRealtimeVoiceCapture(localStreamRef.current)
            : hasValidVoiceNow
            ? startVoiceChangerCapture(localStreamRef.current)
            : Promise.resolve(null);

        const [referenceImage, convertedAudioStream] = await Promise.all([
          referenceImagePromise,
          voicePromise,
        ]);

        let streamForDecartFinal;
        const videoTrack = localStreamRef.current.getVideoTracks()[0];
        if (convertedAudioStream) {
          const convertedAudioTrack = convertedAudioStream.getAudioTracks()[0];
          streamForDecartFinal = new MediaStream([videoTrack, convertedAudioTrack].filter(Boolean));
        } else {
          // Video-only to Decart — mic audio in the stream makes Lucy react to sound as motion.
          streamForDecartFinal = new MediaStream([videoTrack].filter(Boolean));
        }

        const companionAudioStream = convertedAudioStream || localStreamRef.current;
        if (isCompanionApp() && routeAudioToVirtualCable) {
          await startCompanionAudioExport(companionAudioStream);
        }

        activeScenePromptRef.current = sourcePrompt;
        activeSceneUseRefBackgroundRef.current = composeOptions.useReferenceBackground;
        decartSetGuardRef.current = { inFlight: false, lastKey: "", lastAt: 0, reconnectAt: 0 };

        console.info("[InspireTech] Decart connect →", {
          connectPrompt: connectPrompt.slice(0, 160) + (connectPrompt.length > 160 ? "…" : ""),
          enhance: false,
          hasReference: Boolean(selectedFile),
          referenceBackgroundAtStart,
          sceneReferenceAtStart,
          sceneId: pendingScene?.id,
          strategy: referenceBackgroundAtStart
            ? "reference photo background (character + environment from photo)"
            : sceneReferenceAtStart
            ? "scene composite (character photo + room JPG) as reference"
            : "character reference only",
        });

        // Cap Decart metering: timeout must not burn through the WebRTC handshake.
        // Ceiling covers a hung connect(); first-frame window arms after connect returns.
        const connectAttempt = ++connectAttemptRef.current;
        const armTransformTimeout = (ms, label) => {
          clearBillingOpenFallback();
          billingOpenFallbackRef.current = setTimeout(() => {
            if (connectAttemptRef.current !== connectAttempt) return;
            if (!isRunningRef.current || transformOutputReadyRef.current) return;
            console.warn(`[InspireTech] ${label} — disconnecting Decart (no user billing)`);
            setStatus("CONNECT TIMEOUT — NO TRANSFORM VIDEO");
            stopTransformation();
          }, ms);
        };

        armTransformTimeout(
          isCompanionApp() ? TRANSFORM_HANDSHAKE_CEILING_DESKTOP_MS : TRANSFORM_HANDSHAKE_CEILING_MS,
          "Decart handshake ceiling reached"
        );

        const session = await client.realtime.connect(streamForDecartFinal, {
          model: realtimeModel,
          mirror: resolveDecartMirrorMode(streamForDecartFinal),
          resolution: getOutputQualityConfig(outputQuality).resolution,
          preferredVideoCodec: "h264",
          onRemoteStream: (remoteStream) => {
            const video = outputVideoRef.current;
            if (!video) return;
            video.srcObject = remoteStream;
            video.muted = false;
            const requestedResolution = getOutputQualityConfig(outputQuality).resolution;
            const markTransformReady = () => {
              if (!isRunningRef.current || video.videoWidth <= 0) return;
              if (!transformOutputReadyRef.current) {
                transformOutputReadyRef.current = true;
                clearBillingOpenFallback();
                console.info(
                  `[InspireTech] Output stream ${video.videoWidth}x${video.videoHeight} (requested ${requestedResolution})`
                );
                void ensureBillingForGeneration(decartGenerationSecondsRef.current || 0);
              }
            };
            video.addEventListener("loadedmetadata", markTransformReady);
            video.addEventListener("playing", markTransformReady);
            void video.play().then(markTransformReady).catch(() => {});
            if (shouldUseMobileTheater()) {
              requestAnimationFrame(() => {
                void enterOutputTheater({ silent: true, force: true, requireStream: false });
              });
            }
          },
          initialState: {
            prompt: {
              text: connectPrompt,
              // Faster first frames — enhance can be turned on later via Apply.
              enhance: false,
            },
            ...(referenceImage ? { image: referenceImage } : {}),
            passthrough: false,
          },
        });

        // Timed out or stopped while connect() was in flight — drop session so Decart stops.
        if (!isRunningRef.current || connectAttemptRef.current !== connectAttempt) {
          try {
            session.disconnect();
          } catch {
            // ignore
          }
          return;
        }

        // Handshake done — give the first transformed frame its own window.
        if (!transformOutputReadyRef.current) {
          armTransformTimeout(
            isCompanionApp() ? TRANSFORM_CONNECT_TIMEOUT_DESKTOP_MS : TRANSFORM_CONNECT_TIMEOUT_MS,
            "Transform video never arrived after handshake"
          );
        }

        wireDecartSession(session);
        realtimeClientRef.current = session;

        // initialState already has prompt + reference — skip post-connect set() (it delayed first frames).
        if (referenceBackgroundAtStart) {
          activeSceneUseRefBackgroundRef.current = true;
        } else if (sceneReferenceAtStart && pendingScene) {
          activeSceneImageIdRef.current = pendingScene.id;
        }

        if (shouldUseMobileTheater()) {
          void enterOutputTheater({ silent: true, force: true, requireStream: false });
        }
      };

      try {
        await connectWithKey(apiKey);
      } catch (firstErr) {
        const msg = String(firstErr?.message || firstErr || "");
        const invalidKey = /invalid.?api.?key|INVALID_API_KEY|unauthorized|401/i.test(msg);
        if (!invalidKey) throw firstErr;
        console.warn("[InspireTech] Decart rejected API key — minting a fresh token and retrying once");
        clearDecartApiKeyCache();
        apiKey = await ensureDecartApiKey({ forceRefresh: true });
        if (!apiKey) throw firstErr;
        await connectWithKey(apiKey);
      }
    } catch (connectErr) {
      console.error(connectErr);
      const sid = billingSessionIdRef.current;
      billingSessionIdRef.current = null;
      clearClockTimer();
      clearHeartbeat();
      clearBillingOpenFallback();
      if (sid) void endBillingSession(sid);
      const msg = String(connectErr?.message || connectErr || "");
      if (/invalid.?api.?key|INVALID_API_KEY/i.test(msg)) {
        setStatus("DECART KEY REJECTED — CHECK LEDGER DECART_API_KEY / RETRY");
      } else {
        setStatus(`HANDSHAKE REJECTED: ${connectErr.message}`);
      }
      setRunningState(false);
      stopActiveVoicePipeline();
    } finally {
      startInProgressRef.current = false;
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
          decartGenerationSeconds: decartGenerationSecondsRef.current,
        }),
        keepalive: true,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.credits === "number") {
        setCredits(data.credits);
        creditsRef.current = data.credits;
      }
    } catch (err) {
      console.error("Failed to close billing session cleanly:", err);
    }
  };

  const stopTransformation = () => {
    activeScenePromptRef.current = null;
    activeSceneUseRefBackgroundRef.current = false;
    activeSceneImageIdRef.current = "";
    decartSetGuardRef.current = { inFlight: false, lastKey: "", lastAt: 0, reconnectAt: 0 };
    clearBillingOpenFallback();
    transformOutputReadyRef.current = false;
    connectAttemptRef.current += 1;
    const session = realtimeClientRef.current;
    realtimeClientRef.current = null;
    if (session) {
      session.disconnect();
    }
    if (fpsIntervalRef.current) clearInterval(fpsIntervalRef.current);
    clearClockTimer();
    clearHeartbeat();
    stopActiveVoicePipeline();

    const sessionId = billingSessionIdRef.current;
    billingSessionIdRef.current = null;
    billingCreditsStartRef.current = 0;
    sessionCreditsUsedRef.current = 0;
    heartbeatFailCountRef.current = 0;
    decartGenerationSecondsRef.current = 0;
    decartSecondsAtBillingStartRef.current = 0;
    billingStartInFlightRef.current = false;
    if (sessionId) {
      billingEndInFlightRef.current = endBillingSession(sessionId).finally(() => {
        billingEndInFlightRef.current = null;
      });
    }

    setRunningState(false);
    setStatus((prev) => (prev.startsWith("OUT OF CREDITS") ? prev : "PIPELINE DISCONNECTED"));
    setElapsedSeconds(0);
    if (mobileOutputFocus) {
      exitMobileTheater().catch(() => {});
    }
    if (outputVideoRef.current) outputVideoRef.current.srcObject = null;
  };
  stopTransformationRef.current = stopTransformation;

  // Kill orphan Decart/billing sessions if UI thinks we're idle (prevents silent API drain).
  useEffect(() => {
    if (!sessionReady) return undefined;
    const guard = setInterval(() => {
      if (realtimeClientRef.current && !isRunningRef.current) {
        console.warn("[InspireTech] Orphan Decart session detected — forcing stop");
        stopTransformationRef.current();
        return;
      }
      if (billingSessionIdRef.current && !isRunningRef.current) {
        console.warn("[InspireTech] Orphan billing session detected — forcing stop");
        stopTransformationRef.current();
      }
    }, 5000);
    return () => clearInterval(guard);
  }, [sessionReady]);

  // Desktop shell: disconnect Decart when the user closes the Electron window.
  useEffect(() => {
    const companion = window.inspiretechCompanion;
    if (!companion?.onForceTeardown) return undefined;
    return companion.onForceTeardown(() => {
      if (isRunningRef.current || realtimeClientRef.current || billingSessionIdRef.current) {
        stopTransformationRef.current();
      }
    });
  }, []);

  const renderVoiceChangerPanel = () => (
    <div style={styles.sectionCard} className="itc-card itc-section-card">
      <div className="itc-studio-card-title">
        <span>🎙️</span> Voice changer
      </div>
      {!voiceChangerAccess ? (
        <div className="itc-premium-locked-copy">
          <p>{VOICE_UPGRADE_MESSAGE}</p>
          <button type="button" className="itc-btn itc-btn-secondary" onClick={scrollToCreditsSection}>
            View plans — 1,000+ credits
          </button>
        </div>
      ) : (
        <>
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
          <div style={styles.paramsLockedNote} className="itc-params-locked-note">
            {isRunning
              ? "Locked while live — changes apply on next deploy"
              : voiceEngine === "elevenlabs"
              ? `Converts your voice in ~${VOICE_CHUNK_MS / 1000}s clips — speak clearly at the mic. Audio plays through the output video, same as without voice changer.`
              : "Real-time RVC via voice-rt-server (RunPod). Audio plays through the output video. Fan noise is gated before sending to the GPU."}
          </div>
        </>
      )}
    </div>
  );

  const connectionStatusLabel = formatStatusDisplay(status);
  const isLiveStatus =
    status === "COMPUTE LINK ONLINE // REALTIME TRANSFORM TERMINAL" ||
    status === "PROMPT UPDATED // LIVE TRANSFORM" ||
    status === "SCENE UPDATED // LIVE TRANSFORM";

  const renderPromptDock = () => {
    if (!backgroundChangerAccess) {
      return (
        <div className="itc-prompt-dock itc-premium-locked">
          <div className="itc-prompt-dock-header">
            <div>
              <h3 className="itc-prompt-dock-title">Scene library (premium)</h3>
              <p className="itc-prompt-dock-subtitle">{BACKGROUND_UPGRADE_MESSAGE}</p>
            </div>
          </div>
          <button type="button" className="itc-btn itc-btn-secondary" onClick={scrollToCreditsSection}>
            View plans — 2,000+ credits
          </button>
        </div>
      );
    }

    const refBackgroundActive = useReferenceBackground && Boolean(selectedFile);
    const sceneSubtitle = refBackgroundActive
      ? "Your reference photo drives both character and room."
      : isMobileLayout
        ? "Tap a scene — merges your character photo with the preset room (same as reference background)."
        : "Pick a scene — your character photo is placed into the room JPG and sent like a reference photo background.";

    const handleReferenceBackgroundToggle = (enabled) => {
      setUseReferenceBackground(enabled);
      setActiveBackgroundSceneId("");
      activeSceneImageIdRef.current = "";
      setPromptApplyNote("");
      if (isRunning) {
        void applyTransformationPrompt();
      }
    };

    return (
      <div className="itc-prompt-dock itc-scene-dock itc-glass-dock">
        <div className="itc-scene-dock-toolbar">
          <div className="itc-scene-dock-toolbar-main">
            <div className="itc-scene-dock-badge-row">
              <h3 className="itc-prompt-dock-title">
                {refBackgroundActive ? "Reference scene mode" : "Scene library"}
              </h3>
              {!refBackgroundActive && (
                <span className="itc-scene-dock-badge">Instant swap</span>
              )}
            </div>
            <p className="itc-prompt-dock-subtitle">{sceneSubtitle}</p>
          </div>
          <div className={`itc-scene-dock-status-pill itc-glass-pill${isLiveStatus ? " is-live" : ""}`}>
            <span className="itc-companion-pill-icon" aria-hidden="true">{isLiveStatus ? "●" : isRunning ? "◐" : "○"}</span>
            <span>{connectionStatusLabel}</span>
          </div>
        </div>
        <div className="itc-prompt-dock-toggles itc-scene-dock-toggles">
            <label className="itc-prompt-enhance-toggle" title={selectedFile ? undefined : "Upload a reference photo first"}>
              <input
                type="checkbox"
                checked={refBackgroundActive}
                onChange={(e) => handleReferenceBackgroundToggle(e.target.checked)}
                disabled={promptApplyBusy || !selectedFile}
                className="itc-checkbox"
              />
              <span>Use reference photo background</span>
            </label>
            {!refBackgroundActive && (
              <label className="itc-prompt-enhance-toggle">
                <input
                  type="checkbox"
                  checked={enhanceMask}
                  onChange={(e) => setEnhanceMask(e.target.checked)}
                  disabled={promptApplyBusy}
                  className="itc-checkbox"
                />
                <span>Enhance prompt (recommended)</span>
              </label>
            )}
          </div>

        {refBackgroundActive ? (
          <div className="itc-prompt-ref-scene-panel">
            {imagePreview ? (
              <img src={imagePreview} alt="" className="itc-prompt-ref-scene-thumb" />
            ) : null}
            <div className="itc-prompt-ref-scene-copy">
              <p>
                Lucy matches the <strong>environment in your photo</strong> and swaps your character — fully enhanced,
                no extra steps. Your webcam room is replaced edge to edge.
              </p>
              <p className="itc-prompt-ref-scene-hint">
                For a curated scene (presidential suite, hotel, etc.), turn off this option and pick from the gallery.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className={`itc-scene-gallery${isRunning ? " itc-scene-gallery-live" : ""}${proStudioShell ? " itc-scene-gallery-pro" : ""}`} role="list" aria-label="Background scene presets">
              {BACKGROUND_SCENES.map((scene) => {
                const isActive = activeBackgroundSceneId === scene.id;
                const isApplying = applyingSceneId === scene.id;
                return (
                  <button
                    key={scene.id}
                    type="button"
                    role="listitem"
                    className={`itc-scene-card${isActive ? " is-active" : ""}${isApplying ? " is-applying" : ""}`}
                    onClick={() => void applyBackgroundScene(scene)}
                    disabled={promptApplyBusy && !isApplying}
                    aria-pressed={isActive}
                    title={scene.tagline}
                  >
                    <span className="itc-scene-card-media">
                      <img src={scene.image} alt="" className="itc-scene-card-image" loading="lazy" decoding="async" />
                      <span className="itc-scene-card-shimmer" aria-hidden="true" />
                      {isActive && !isApplying && (
                        <span className="itc-scene-card-check" aria-hidden="true">✓</span>
                      )}
                    </span>
                    <span className="itc-scene-card-body">
                      <span className="itc-scene-card-label">{scene.label}</span>
                      {scene.category && (
                        <span className="itc-scene-card-category">{scene.category}</span>
                      )}
                    </span>
                    {isApplying && (
                      <span className="itc-scene-card-status" aria-live="polite">
                        Applying…
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {backgroundUpdatedNote && (
              <div className="itc-background-updated-toast" role="status">
                {backgroundUpdatedNote}
              </div>
            )}

            <div className="itc-scene-custom-wrap">
              <button
                type="button"
                className="itc-scene-custom-toggle"
                onClick={() => setShowCustomPrompt((open) => !open)}
                aria-expanded={showCustomPrompt}
              >
                {showCustomPrompt ? "Hide custom prompt" : "Write your own background prompt"}
              </button>
              {showCustomPrompt && (
                <div className="itc-scene-custom-panel">
                  <textarea
                    className="itc-prompt-input"
                    value={transformationPrompt}
                    onChange={(e) => handleCustomPromptChange(e.target.value)}
                    rows={2}
                    placeholder="Describe a custom background, e.g. Change the background to a rooftop lounge at dusk…"
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                        e.preventDefault();
                        void applyTransformationPrompt();
                      }
                    }}
                  />
                </div>
              )}
            </div>
          </>
        )}

        <div className="itc-prompt-actions">
          {(showCustomPrompt && !refBackgroundActive) || (refBackgroundActive && isRunning) ? (
            <button
              type="button"
              className="itc-btn itc-btn-primary"
              onClick={() => void applyTransformationPrompt()}
              disabled={promptApplyBusy}
            >
              {promptApplyBusy ? "Applying…" : isRunning ? "Apply to live stream" : "Save prompt"}
            </button>
          ) : null}
          {promptApplyNote && <span className="itc-prompt-note">{promptApplyNote}</span>}
        </div>
      </div>
    );
  };

  const showPromptBelowOutput =
    !isMobileWebStudio && !isMobileLayout && (!proStudioShell || companionNavSection === "studio");
  const showPromptInSidebar = isMobileLayout && isRunning && !isMobileWebStudio;

  const purchaseCredits = (creditAmount) => {
    if (!allowPurchase) {
      setCheckoutContactError(
        "Self-serve top-up is locked on this trial. Message us on WhatsApp to purchase a plan."
      );
      setStatus("TRIAL CHECKOUT LOCKED — CONTACT ADMIN TO PURCHASE");
      return;
    }
    const pack = TOP_UP_OPTIONS.find((opt) => opt.credits === creditAmount) || null;
    setSelectedTopUp(pack);
    setCheckoutContactError("");
    if (!pack) {
      setStatus("SELECT A CREDIT PACK");
      return;
    }
    setStatus(`OPENING CHECKOUT — ${pack.credits.toLocaleString()} CREDITS`);
    navigate(`/pay?credits=${pack.credits}`);
  };

  const creditPercent = Math.min(100, (credits / 500) * 100);
  const isLowCredit = credits <= LOW_CREDIT_THRESHOLD;
  const isTrialLocked = isTrialAccount && !allowPurchase;
  const trialEnded = isTrialLocked && creditsLoaded && credits <= 0;
  const trialTimeLeftLabel = isTrialLocked && credits > 0
    ? formatRemainingLiveTime(credits)
    : "";
  const weakNetwork = networkChecked && networkQuality.level === NETWORK_QUALITY.POOR;
  const outputQualityConfig = getOutputQualityConfig(outputQuality);
  const startBlocked =
    isRunning || !selectedFile || credits <= 0 || ledgerUnreachable || weakNetwork;
  const networkChipTone =
    networkQuality.level === NETWORK_QUALITY.GOOD
      ? " is-live"
      : networkQuality.level === NETWORK_QUALITY.FAIR
        ? " is-warn"
        : networkQuality.level === NETWORK_QUALITY.POOR
          ? " is-danger"
          : "";
  const studioPanelSectionClass = (section) => {
    if (!proStudioShell) return "";
    if (STUDIO_PANEL_SECTIONS.has(section)) {
      return companionNavSection === "studio" ? "" : "itc-companion-hidden";
    }
    return companionNavSection === section ? "" : "itc-companion-hidden";
  };

  const renderStatusRibbon = () => {
    if (isMobileWebStudio) {
      return (
        <div className="itc-status-ribbon itc-status-ribbon-compact">
          <div className="itc-status-chip">
            <span className="itc-status-chip-label">Status</span>
            <span className={`itc-status-chip-value${isLiveStatus ? " is-live" : ""}`} style={!isRunning ? { color: c.amber } : undefined}>
              {connectionStatusLabel}
            </span>
          </div>
          <div className="itc-status-chip">
            <span className="itc-status-chip-label">Network</span>
            <span className={`itc-status-chip-value${networkChipTone}`} title={networkQuality.message}>
              {networkChecked ? networkQualityLabel(networkQuality.level) : "…"}
            </span>
          </div>
          <div className="itc-status-chip">
            <span className="itc-status-chip-label">Credits</span>
            <span
              className={`itc-status-chip-value itc-mono${isLowCredit || trialEnded ? " is-danger" : ""}`}
              style={{ animation: isLowCredit && isRunning ? "creditPulse 1s infinite" : "none" }}
            >
              {creditsLoaded ? credits : "…"}
            </span>
          </div>
          {isTrialLocked ? (
            <div className="itc-status-chip">
              <span className="itc-status-chip-label">Trial</span>
              <span className={`itc-status-chip-value${trialEnded ? " is-danger" : ""}`}>
                {trialEnded ? "Ended" : `${trialTimeLeftLabel} left`}
              </span>
            </div>
          ) : null}
        </div>
      );
    }

    return (
    <div className="itc-status-ribbon">
      <div className="itc-status-chip">
        <span className="itc-status-chip-label">Status</span>
        <span className={`itc-status-chip-value${isLiveStatus ? " is-live" : ""}`} style={!isRunning ? { color: c.amber } : undefined}>
          {connectionStatusLabel}
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
        <span className="itc-status-chip-label">Network</span>
        <span
          className={`itc-status-chip-value itc-mono${networkChipTone}`}
          title={networkQuality.message}
        >
          {networkChecked
            ? `${networkQualityLabel(networkQuality.level)}${Number.isFinite(networkQuality.latencyMs) ? ` · ${Math.round(networkQuality.latencyMs)} ms` : ""}`
            : "…"}
        </span>
      </div>
      <div className="itc-status-chip">
        <span className="itc-status-chip-label">Credits</span>
        <span
          className={`itc-status-chip-value itc-mono${isLowCredit || trialEnded ? " is-danger" : ""}`}
          style={{ animation: isLowCredit && isRunning ? "creditPulse 1s infinite" : "none" }}
        >
          {creditsLoaded ? credits : "…"}
          {creditsLoaded && <span style={styles.creditsDollar}> ({formatUsdFromCredits(credits)})</span>}
        </span>
      </div>
      {isTrialLocked ? (
        <div className="itc-status-chip">
          <span className="itc-status-chip-label">Trial</span>
          <span className={`itc-status-chip-value${trialEnded ? " is-danger" : ""}`}>
            {trialEnded ? "Ended" : `${trialTimeLeftLabel} left`}
          </span>
        </div>
      ) : null}
    </div>
    );
  };

  const renderProStudioTopbar = () => (
    <header className="itc-companion-topbar itc-glass-topbar">
      <div className="itc-companion-topbar-left">
        <LogoLockup size="sm" />
      </div>
      <nav className="itc-companion-nav-horizontal" aria-label="Studio sections">
        {studioNavItems.map((section) => (
          <button
            key={section.id}
            type="button"
            className={`itc-companion-nav-tab${companionNavSection === section.id ? " is-active" : ""}`}
            onClick={() => setCompanionNavSection(section.id)}
          >
            <span className="itc-companion-nav-icon" aria-hidden="true">{section.icon}</span>
            <span>{section.label}</span>
            {section.id === "drivers" && driverSetupFailed && (
              <span className="itc-companion-nav-badge" aria-label="Driver setup needs attention" />
            )}
          </button>
        ))}
      </nav>
      <div className="itc-companion-topbar-right">
        <div className={`itc-companion-pill itc-glass-pill${isLiveStatus ? " is-live" : ""}`} title={status}>
          <span className="itc-companion-pill-icon" aria-hidden="true">
            {isLiveStatus ? "●" : isRunning ? "◐" : "○"}
          </span>
          <span className="itc-companion-pill-value">{connectionStatusLabel}</span>
        </div>
        {isRunning && (
          <div className="itc-companion-pill itc-glass-pill">
            <span className="itc-companion-pill-label">Session</span>
            <span className="itc-companion-pill-value itc-mono">{formatTime(elapsedSeconds)}</span>
          </div>
        )}
        <div className={`itc-companion-pill itc-glass-pill itc-companion-pill-credits${isLowCredit || trialEnded ? " is-danger" : ""}`}>
          <span className="itc-companion-pill-label">Credits</span>
          <span className="itc-companion-pill-value itc-mono">{creditsLoaded ? credits : "…"}</span>
        </div>
        {isTrialLocked ? (
          <div className={`itc-companion-pill itc-glass-pill itc-trial-pill${trialEnded ? " is-ended" : ""}`}>
            <span className="itc-companion-pill-label">Trial</span>
            <span className="itc-companion-pill-value">
              {trialEnded ? "Ended" : `${trialTimeLeftLabel} left`}
            </span>
          </div>
        ) : null}
        {companionToolbar && desktopAppVersion && (
          <div className="itc-companion-pill itc-glass-pill itc-companion-pill-version">
            <span className="itc-companion-pill-sub">Desktop</span>
            <span className="itc-companion-pill-value">v{desktopAppVersion}</span>
          </div>
        )}
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
        {!companionToolbar && (
          <Link to="/" className="itc-header-link">
            Home
          </Link>
        )}
        {companionToolbar && (
          <button type="button" className="itc-header-link" onClick={handleManualAppUpdateCheck}>
            Updates
          </button>
        )}
      </div>
    </header>
  );

  // No access token yet — show sign-in gate (landing page lives at /).
  if (!accessToken || !sessionReady) {
    const verifyingSaved = Boolean(accessToken && !sessionReady);
    return (
      <>
        <AccessGate
          companionMode={isCompanionApp()}
          onAuthenticated={handleGateAuthenticated}
          tokenError={tokenError}
          loading={gateLoading || verifyingSaved}
          setupMessage={verifyingSaved ? "Checking your saved access token…" : gateSetupMessage}
        />
        {renderAppUpdateModal()}
      </>
    );
  }

  return (
    <>
    <div
      style={styles.appContainer}
      className={`itc-app${proStudioShell ? " itc-app-companion" : ""}${isMobileLayout ? " itc-app-mobile" : ""}${isMobileWebStudio ? " itc-mobile-web" : ""}${mobileOutputFocus ? " itc-output-theater itc-mobile-theater" : ""}${isMobileLayout && !mobileControlsOpen ? " itc-mobile-sidebar-collapsed" : ""}`}
    >
      {proStudioShell ? (
        renderProStudioTopbar()
      ) : (
      <header className={`itc-top-header${companionToolbar ? " itc-top-header-companion" : ""}`}>
        <div className="itc-header-brand">
          <div className="itc-header-brand-id">
            <LogoLockup size={companionToolbar ? "sm" : "md"} />
            {!isMobileWebStudio && !companionToolbar && <span className="itc-header-version">v2.8</span>}
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
            {companionToolbar && driverSetupFailed && (
              <button
                type="button"
                className="itc-header-link"
                disabled={driverSetupBusy}
                onClick={retryCompanionDriverSetup}
              >
                {driverSetupBusy ? "Retrying drivers…" : "Retry driver install"}
              </button>
            )}
            {companionToolbar && desktopAppVersion && (
              <span className="itc-header-version">Desktop v{desktopAppVersion}</span>
            )}
            {companionToolbar && (
              <button
                type="button"
                className="itc-header-link"
                onClick={handleManualAppUpdateCheck}
              >
                Updates
              </button>
            )}
            {!companionToolbar && (
              <Link to="/" className="itc-header-link">
                Home
              </Link>
            )}
          </div>
        </div>

        {companionToolbar ? (
          <div className="itc-header-companion-bar">
            <nav className="itc-desktop-toolbar" aria-label="Studio sections">
              {studioNavItems.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className={`itc-desktop-toolbar-item${companionNavSection === section.id ? " is-active" : ""}`}
                  onClick={() => setCompanionNavSection(section.id)}
                >
                  <span className="itc-desktop-toolbar-icon" aria-hidden="true">
                    {section.icon}
                  </span>
                  <span>{section.label}</span>
                  {section.id === "drivers" && driverSetupFailed && (
                    <span className="itc-desktop-toolbar-badge" aria-label="Driver setup needs attention" />
                  )}
                </button>
              ))}
            </nav>
            {renderStatusRibbon()}
          </div>
        ) : (
          renderStatusRibbon()
        )}
      </header>
      )}

      <div
        style={proStudioShell ? undefined : styles.mainWorkspace}
        className={proStudioShell ? "itc-companion-body itc-companion-body-horizontal" : "itc-main-workspace"}
      >
        <aside
          style={proStudioShell ? undefined : styles.controlSidebar}
          className={proStudioShell ? "itc-companion-panel itc-sidebar" : "itc-sidebar"}
        >

          <div className={`${studioPanelSectionClass("devices")} itc-sidebar-section itc-sidebar-section-devices`}>
          <div style={styles.sectionCard} className="itc-card itc-section-card">
            {isMobileWebStudio ? (
              <>
                <div className="itc-studio-card-title">Setup</div>
                <div className="itc-mobile-setup">
                  <button
                    type="button"
                    className="itc-mobile-ref-picker"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isRunning}
                  >
                    {imagePreview ? (
                      <img src={imagePreview} alt="" className="itc-mobile-ref-thumb" />
                    ) : (
                      <span className="itc-mobile-ref-empty">Tap to choose reference photo</span>
                    )}
                  </button>
                  <input type="file" ref={fileInputRef} accept="image/*" style={{ display: "none" }} onChange={(e) => handleFileChange(e.target.files?.[0])} />
                  <button
                    type="button"
                    className="itc-btn itc-btn-primary itc-mobile-setup-btn"
                    onClick={() => startCamera()}
                    disabled={isRunning}
                  >
                    {cameraActive ? "Camera on" : "Turn on camera"}
                  </button>
                  <label className="itc-mobile-mic-toggle">
                    <input
                      type="checkbox"
                      checked={mobileMicEnabled}
                      onChange={(e) => void handleMobileMicEnabledChange(e.target.checked)}
                      disabled={isRunning}
                      className="itc-checkbox"
                    />
                    <span>Use microphone</span>
                  </label>
                  {!mobileMicEnabled && (
                    <p className="itc-mobile-setup-hint">Mic off — video-only live stream.</p>
                  )}
                  <div className="itc-mobile-quality-row">
                    <label className="itc-studio-label" htmlFor="itc-output-quality-mobile">
                      Output quality
                    </label>
                    <select
                      id="itc-output-quality-mobile"
                      className="itc-select itc-quality-select"
                      value={outputQuality}
                      onChange={(e) => setOutputQuality(e.target.value)}
                      disabled={isRunning}
                    >
                      {OUTPUT_QUALITY_OPTIONS.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.resolution} — {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {!cameraActive && (
                    <p className="itc-mobile-setup-hint">Allow camera access when your browser asks.</p>
                  )}
                  {networkChecked && !isRunning && (
                    <p
                      className={`itc-mobile-setup-hint itc-network-hint${
                        weakNetwork ? " is-poor" : networkQuality.level === NETWORK_QUALITY.FAIR ? " is-fair" : ""
                      }`}
                    >
                      {networkQuality.message}
                    </p>
                  )}
                  {!isRunning && (
                    <div className="itc-mobile-setup-background">
                      {renderPromptDock()}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
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
                : weakNetwork
                ? networkQuality.message
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
              </>
            )}
          </div>
          </div>

          <div className={`${studioPanelSectionClass("credits")} itc-sidebar-section itc-sidebar-section-credits`}>
          <div style={styles.sectionCard} className="itc-card itc-section-card">
            <div className="itc-studio-card-title">
              <span>{isMobileWebStudio ? "" : "💳 "}</span>
              {isMobileWebStudio ? "Credits" : "Credit balance"}
            </div>
            {ledgerUnreachable ? (
              <div style={styles.ledgerErrorNote}>
                Can't reach the billing server. Check your connection and try again.
              </div>
            ) : (
              <>
                {isTrialLocked ? (
                  <div className={`itc-trial-banner${trialEnded ? " is-ended" : ""}`}>
                    {trialEnded
                      ? "Trial ended — message us on WhatsApp to buy a plan and unlock checkout."
                      : `Trial · ${trialTimeLeftLabel} left · self-serve top-up stays locked until you purchase.`}
                  </div>
                ) : null}
                <div style={styles.creditBalanceRow}>
                  <span style={styles.creditBalanceNumber}>{creditsLoaded ? credits : "…"}</span>
                  {!isMobileWebStudio && (
                    <span style={styles.creditBalanceSub}>credits · {creditsLoaded ? formatUsdFromCredits(credits) : "—"}</span>
                  )}
                </div>
                {!isMobileWebStudio && (
                  <>
                    <div style={styles.creditBarTrack}>
                      <div style={{...styles.creditBarFill, width: `${creditPercent}%`, backgroundColor: isLowCredit || trialEnded ? c.rose : c.primary}} />
                    </div>
                    <div style={styles.creditMeta}>
                      <span>~{DISPLAY_CREDITS_PER_SECOND} credits/sec while live (billed when output starts)</span>
                      {isRunning && <span>Used this session: {sessionCreditsUsed} ({formatUsdFromCredits(sessionCreditsUsed)})</span>}
                    </div>
                  </>
                )}
                {isMobileWebStudio && isRunning && (
                  <p className="itc-mobile-setup-hint">~{DISPLAY_CREDITS_PER_SECOND} credits/sec once live output begins.</p>
                )}
              </>
            )}
            <button
              style={styles.topUpButton}
              className="itc-btn itc-btn-topup"
              onClick={() => setShowAddCredits(true)}
            >
              {isTrialLocked ? (trialEnded ? "Buy a plan" : "Upgrade / buy plan") : "+ Add Credits"}
            </button>
          </div>
          </div>

          {!isMobileWebStudio && (
          <div className={`${studioPanelSectionClass("studio")} itc-sidebar-section itc-sidebar-section-ref`}>
          <div style={styles.sectionCard} className="itc-card itc-section-card">
            <div className="itc-studio-card-title">
              <span>🖼️</span> Reference image
            </div>
            <div className="itc-reference-image-box">
              {imagePreview ? (
                <img src={imagePreview} alt="Target Reference" />
              ) : (
                <div style={styles.emptyBoxPlaceholder}>No reference image yet</div>
              )}
            </div>
          </div>
          </div>
          )}

          {!isMobileWebStudio && (
          <div className={`${studioPanelSectionClass("voice")} itc-sidebar-section itc-sidebar-section-voice`}>
          {renderVoiceChangerPanel()}
          </div>
          )}

          {!isMobileWebStudio && (
          <div className={`${studioPanelSectionClass("studio")} itc-sidebar-section itc-sidebar-section-preview`}>
          <div style={styles.sectionCard} className="itc-card itc-section-card">
            <div className="itc-studio-card-title">
              <span>👁️</span> Local preview
            </div>
            <div style={styles.sidebarVideoWrapper} className="itc-local-video-wrapper">
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                style={{
                  ...styles.localPreviewVideo,
                  ...(mirrorLocalPreview ? { transform: "scaleX(-1)" } : {}),
                }}
                className="itc-local-video"
              />
            </div>
          </div>
          </div>
          )}

          {(!isMobileWebStudio || showAddCredits) && (
          <div className={`${studioPanelSectionClass("credits")} itc-sidebar-section itc-sidebar-section-topup`}>
          <div ref={creditSectionRef} style={{...styles.sectionCard, ...(showAddCredits ? styles.sectionCardAlert : {})}} className="itc-card itc-section-card">
            <div className="itc-studio-card-title">
              <span>{isMobileWebStudio ? "" : "💳 "}</span>
              {allowPurchase ? "Buy credits" : isTrialAccount ? "Trial account" : "Purchase locked"}
            </div>
            {!allowPurchase ? (
              <div style={styles.checkoutContactBlock}>
                <p style={styles.checkoutContactHint}>
                  {trialEnded
                    ? "Your free trial has ended. Self-serve checkout stays locked until admin unlocks you after a paid plan."
                    : isTrialAccount
                    ? "Your free trial includes starter credits only. Self-serve top-up is locked until you purchase a real plan with us."
                    : "Checkout is locked on this account. Contact us to unlock purchasing."}
                </p>
                <p style={styles.checkoutContactHint}>
                  Message us on WhatsApp with the plan you want ($70 / $80 / $120). Access requests include our USDT
                  address with the price list — we unlock your account after payment.
                </p>
                <WhatsAppLink
                  message={WHATSAPP_TRIAL_PURCHASE_MESSAGE}
                  className="itc-btn itc-btn-secondary"
                >
                  {trialEnded ? "Message WhatsApp to purchase" : "Contact admin on WhatsApp"}
                </WhatsAppLink>
                {checkoutContactError && (
                  <div style={{ ...styles.checkoutContactError, marginTop: 10 }}>{checkoutContactError}</div>
                )}
              </div>
            ) : (
              <>
            {!isMobileWebStudio && (
              <p style={styles.modalSubtitle}>
                Choose a pack to open secure checkout and pick your payment method.
              </p>
            )}
            <div style={styles.creditCardGrid} className="itc-credit-grid">
              {TOP_UP_OPTIONS.map((opt) => {
                const isSelected = selectedTopUp?.credits === opt.credits;
                return (
                <div
                  key={opt.credits}
                  className={`itc-credit-card${opt.popular ? " is-popular" : ""}${isSelected ? " is-selected" : ""}`}
                  style={{
                    ...styles.creditCard,
                    ...(opt.popular ? styles.creditCardPopular : {}),
                    ...(isSelected ? styles.creditCardSelected : {}),
                  }}
                >
                  {opt.popular && <div style={styles.popularBadge}>Popular</div>}
                  <div style={{...styles.creditCardIcon, ...(opt.popular ? styles.creditCardIconPopular : {})}}>⚡</div>
                  <div style={styles.creditCardAmount}>{opt.credits.toLocaleString()}</div>
                  <div style={styles.creditCardLabel}>{formatLiveTimeFromCredits(opt.credits)} live</div>
                  <div style={styles.creditCardPrice}>
                    <span style={styles.creditCardPriceMain}>{formatNaira(opt.naira)}</span>
                    <span style={styles.creditCardPriceSub}>≈ {formatUsdFromNaira(opt.naira)}</span>
                  </div>
                  <button
                    type="button"
                    style={{...styles.creditCardBuyBtn, ...(opt.popular ? styles.creditCardBuyBtnPopular : {}), ...(isSelected ? styles.creditCardBuyBtnSelected : {})}}
                    className="itc-credit-select-btn"
                    onClick={() => purchaseCredits(opt.credits)}
                  >
                    Pay
                  </button>
                </div>
                );
              })}
            </div>
            {checkoutContactError && (
              <div style={{ ...styles.checkoutContactError, marginTop: 10 }}>{checkoutContactError}</div>
            )}
            <div style={styles.modalNote}>
              You’ll choose USDT or bank transfer on the next page. Credits are added after we confirm payment.
            </div>
              </>
            )}
          </div>
          </div>
          )}

          {companionToolbar && (
            <div className={studioPanelSectionClass("drivers")}>
              <div style={styles.sectionCard} className="itc-card itc-section-card">
                <div className="itc-studio-card-title">
                  <span>🖥️</span> Virtual drivers
                </div>
                <div style={styles.compatNote}>
                  <strong>InspireTech Camera</strong>{" "}
                  {driverCameraInstalled == null
                    ? "— checking…"
                    : driverCameraInstalled
                    ? "is installed"
                    : "is not installed"}
                  . Pick it as your camera in calling apps (Zoom, Telegram, Discord, WhatsApp Web).
                </div>
                <div style={styles.compatNote}>
                  <strong>VB-Audio Virtual Cable</strong>{" "}
                  {vbCableBundled === false
                    ? "is not bundled in this build — download the latest installer from inspirestream.xyz."
                    : driverAudioInstalled == null
                    ? "— checking…"
                    : driverAudioInstalled
                    ? "is installed"
                    : "is not installed"}
                  .{" "}
                  {routeAudioToVirtualCable
                    ? "Voice is routed to CABLE Output for calling apps."
                    : "Enable “Route audio to VB-CABLE” under Devices after installing."}
                </div>
                <div style={styles.compatNote}>
                  WhatsApp Desktop cannot see InspireTech Camera — use Telegram, Discord, or WhatsApp Web.
                </div>
                <div style={styles.buttonStack}>
                  <button
                    type="button"
                    className="itc-btn itc-btn-primary"
                    disabled={driverSetupBusy}
                    onClick={reinstallCompanionCamera}
                  >
                    {driverSetupBusy ? "Installing camera driver…" : driverCameraInstalled ? "Reinstall InspireTech Camera" : "Install InspireTech Camera"}
                  </button>
                  <button
                    type="button"
                    className="itc-btn itc-btn-secondary"
                    disabled={driverSetupBusy || vbCableBundled === false}
                    onClick={() => installCompanionVbCable({ forceReinstall: Boolean(driverAudioInstalled) })}
                  >
                    {driverSetupBusy
                      ? "Installing VB-CABLE…"
                      : driverAudioInstalled
                      ? "Reinstall VB-CABLE"
                      : "Install VB-CABLE"}
                  </button>
                  {driverSetupFailed && (
                    <button
                      type="button"
                      className="itc-btn itc-btn-secondary"
                      disabled={driverSetupBusy}
                      onClick={retryCompanionDriverSetup}
                    >
                      Retry full driver setup
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {proStudioShell && (
            <div className={studioPanelSectionClass("account")}>
              <div style={styles.sectionCard} className="itc-card itc-section-card">
                <div className="itc-studio-card-title">
                  <span>⚙️</span> {companionToolbar ? "Desktop app" : "Account"}
                </div>
                {companionToolbar ? (
                  <>
                    <div style={styles.creditMeta}>
                      <span>Installed version: {desktopAppVersion || "…"}</span>
                    </div>
                    <div style={styles.buttonStack}>
                      <button
                        type="button"
                        className="itc-btn itc-btn-secondary"
                        onClick={handleManualAppUpdateCheck}
                      >
                        Check for app updates
                      </button>
                      <button
                        type="button"
                        className="itc-btn itc-btn-secondary"
                        onClick={() => {
                          if (isRunning) stopTransformation();
                          clearAccessToken();
                        }}
                      >
                        Switch access token
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div style={styles.creditMeta}>
                      <span>Platform: Web studio</span>
                      <span>Output quality is set before you go live.</span>
                    </div>
                    <div style={styles.buttonStack}>
                      <button
                        type="button"
                        className="itc-btn itc-btn-secondary"
                        onClick={() => {
                          if (isRunning) stopTransformation();
                          clearAccessToken();
                        }}
                      >
                        Switch access token
                      </button>
                      <Link to="/" className="itc-btn itc-btn-secondary" style={{ textAlign: "center", textDecoration: "none" }}>
                        Back to home
                      </Link>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {companionToolbar && !proStudioShell && (
            <div className={studioPanelSectionClass("account")}>
              <div style={styles.sectionCard} className="itc-card itc-section-card">
                <div className="itc-studio-card-title">
                  <span>⚙️</span> Desktop app
                </div>
                <div style={styles.creditMeta}>
                  <span>Installed version: {desktopAppVersion || "…"}</span>
                </div>
                <div style={styles.buttonStack}>
                  <button
                    type="button"
                    className="itc-btn itc-btn-secondary"
                    onClick={handleManualAppUpdateCheck}
                  >
                    Check for app updates
                  </button>
                  <button
                    type="button"
                    className="itc-btn itc-btn-secondary"
                    onClick={() => {
                      if (isRunning) stopTransformation();
                      clearAccessToken();
                    }}
                  >
                    Switch access token
                  </button>
                </div>
              </div>
            </div>
          )}
          {showPromptInSidebar && (
            <div className="itc-sidebar-section itc-sidebar-section-prompt">{renderPromptDock()}</div>
          )}
        </aside>

        <div className={proStudioShell ? "itc-companion-stage itc-studio-stage" : "itc-studio-stage"}>
        <main style={styles.outputCanvas} className="itc-output-canvas">
          <div style={styles.canvasControlBar} className={`itc-canvas-control-bar${isMobileWebStudio ? " itc-canvas-control-bar-mobile" : ""}`}>
            <div style={styles.canvasTitleGroup} className="itc-canvas-title-group">
              <h2 className="itc-canvas-title">{isMobileWebStudio ? "Live output" : "Output monitor"}</h2>
              {!isMobileWebStudio && (
                <span className="itc-canvas-subtitle" style={styles.canvasSubtitle}>
                  {outputQualityConfig.label} · {outputQualityConfig.subtitle} · Lucy 2.5
                </span>
              )}
            </div>
            <div className="itc-output-quality-wrap">
              <label className="itc-studio-label itc-output-quality-label" htmlFor="itc-output-quality">
                Output quality
              </label>
              <select
                id="itc-output-quality"
                className="itc-select itc-quality-select"
                value={outputQuality}
                onChange={(e) => setOutputQuality(e.target.value)}
                disabled={isRunning}
                title={isRunning ? "Stop the stream to change quality" : "Choose output resolution before going live"}
              >
                {OUTPUT_QUALITY_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.resolution} — {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div style={styles.actionRow} className="itc-action-row itc-desktop-action-row">
              <button
                style={{...styles.actionButton, ...styles.startButton, opacity: startBlocked ? 0.5 : 1}}
                className="itc-btn itc-btn-start"
                onClick={startTransformation}
                disabled={startBlocked}
                title={weakNetwork ? networkQuality.message : undefined}
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
                style={{...styles.actionButton, ...styles.popOutButton, opacity: !pipSupported && !isMobileLayout && !outputTheaterSupported ? 0.5 : 1}}
                className="itc-btn itc-btn-secondary"
                onClick={handlePopOutVideo}
                disabled={!pipSupported && !isMobileLayout && !outputTheaterSupported}
                title={
                  isMobileLayout || !pipSupported
                    ? "Expand output to full screen"
                    : pipSupported
                    ? "Pop the output video into its own floating window — capture that window in OBS/your calling app"
                    : "Full screen output"
                }
              >
                {isPoppedOut || mobileOutputFocus
                  ? "Return to app"
                  : isMobileLayout || !pipSupported
                  ? "Full screen output"
                  : "Pop out for OBS"}
              </button>
            </div>
          </div>

          <div style={styles.canvasViewportContainer} className="itc-canvas-viewport">
            <div style={styles.outputColumn} className="itc-output-column">
              {isRunning && (
                <div style={styles.timerBadgeRow} className="itc-timer-badge-row">
                  <div style={styles.timerBadgeOutside}>{formatTime(elapsedSeconds)}</div>
                  {!isMobileWebStudio && (
                    <div style={{...styles.timerBadgeOutside, color: isLowCredit ? c.rose : c.primary}}>
                      {credits} credits left
                    </div>
                  )}
                </div>
              )}
              <div style={styles.fixedOutputContainer} className={`itc-fixed-output${isRunning ? " itc-live" : ""}${sceneTransitionActive ? " itc-scene-transitioning" : ""}`}>
                <video ref={outputVideoRef} autoPlay playsInline style={styles.outputVideo} className="itc-output-video" />
                {sceneTransitionActive && isRunning && (
                  <div className="itc-scene-transition-overlay" aria-live="polite">
                    <div className="itc-scene-transition-bar-track">
                      <div className="itc-scene-transition-bar-fill" />
                    </div>
                    <span className="itc-scene-transition-label">Switching scene…</span>
                  </div>
                )}
                {isRunning && (
                  <div className="itc-output-live-bar">
                    <select
                      className="itc-quality-select itc-quality-select-overlay"
                      value={outputQuality}
                      disabled
                      aria-label="Current output quality"
                      title="Stop the stream to change quality — set Full HD (1080p) before going live"
                    >
                      {OUTPUT_QUALITY_OPTIONS.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.resolution}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {isRunning && outputTheaterSupported && !isMobileLayout && (
                  <button
                    type="button"
                    className={`itc-output-fullscreen-toggle${mobileOutputFocus ? " is-active" : ""}${mobileOutputFocus && !theaterControlsVisible ? " itc-theater-controls-hidden" : ""}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void toggleOutputTheater();
                    }}
                    onTouchStart={(event) => event.stopPropagation()}
                    aria-label={mobileOutputFocus ? "Exit full screen" : "Full screen"}
                    title={mobileOutputFocus ? "Exit full screen" : "Full screen output"}
                  >
                    {mobileOutputFocus ? (
                      <span aria-hidden="true" className="itc-output-fullscreen-toggle-icon">
                        ✕
                      </span>
                    ) : (
                      <span aria-hidden="true" className="itc-output-fullscreen-toggle-icon">
                        ⛶
                      </span>
                    )}
                  </button>
                )}
                {!isRunning && (
                  <div style={styles.canvasOverlay}>
                    <div style={styles.overlayPingWrap}>
                      <div style={styles.overlayRadarPing} />
                      <div style={styles.overlayPingDot} />
                    </div>
                    <div style={styles.overlayText}>
                      {trialEnded
                        ? "Trial ended"
                        : credits <= 0 && creditsLoaded
                        ? "Out of credits"
                        : "Not connected"}
                    </div>
                    <div style={styles.overlaySubtext}>
                      {trialEnded
                        ? "Message us on WhatsApp to buy a plan ($70 / $80 / $120). USDT details are included — we unlock your account after payment."
                        : credits <= 0 && creditsLoaded
                        ? "Add credits to continue."
                        : weakNetwork
                        ? networkQuality.message
                        : isMobileWebStudio
                        ? "Choose a photo and turn on your camera, then tap Go live."
                        : "Upload a reference image, start your camera, then hit Start transformation."}
                    </div>
                    {trialEnded ? (
                      <div className="itc-trial-ended-actions">
                        <WhatsAppLink
                          message={WHATSAPP_TRIAL_PURCHASE_MESSAGE}
                          className="itc-btn itc-btn-primary"
                        >
                          Buy a plan on WhatsApp
                        </WhatsAppLink>
                        <button
                          type="button"
                          className="itc-btn itc-btn-secondary"
                          onClick={scrollToCreditsSection}
                        >
                          Open purchase panel
                        </button>
                      </div>
                    ) : null}
                    {networkChecked && !weakNetwork && networkQuality.level === NETWORK_QUALITY.FAIR && (
                      <p className="itc-network-hint is-fair">{networkQuality.message}</p>
                    )}
                  </div>
                )}
              </div>

              {showPromptBelowOutput && renderPromptDock()}
            </div>
          </div>
        </main>
        </div>
      </div>

      {mobileOutputFocus && (
        <>
          <div
            className="itc-mobile-theater-tap-layer itc-output-theater-tap-layer"
            onClick={revealTheaterControls}
            onTouchStart={revealTheaterControls}
            aria-hidden="true"
          />
          <button
            type="button"
            className={`itc-btn itc-btn-stop itc-mobile-theater-stop itc-output-theater-stop${theaterControlsVisible ? "" : " itc-theater-controls-hidden"}`}
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
        <div className={`itc-mobile-action-dock${isMobileWebStudio ? " itc-mobile-action-dock-simple" : ""}`}>
          <button
            type="button"
            className="itc-btn itc-btn-secondary"
            onClick={() => setMobileControlsOpen((open) => !open)}
          >
            {mobileControlsOpen ? (isMobileWebStudio ? "Hide" : "Hide setup") : "Setup"}
          </button>
          <button
            type="button"
            className="itc-btn itc-btn-start"
            onClick={startTransformation}
            disabled={startBlocked}
            title={weakNetwork ? networkQuality.message : undefined}
          >
            {isMobileWebStudio ? "Go live" : "Start"}
          </button>
          <button
            type="button"
            className="itc-btn itc-btn-stop"
            onClick={stopTransformation}
            disabled={!isRunning}
          >
            Stop
          </button>
        </div>
      )}
    </div>
    {renderAppUpdateModal()}
    </>
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
  controlSidebar: { flex: "0 0 280px", width: "280px", maxWidth: "100%", borderRight: `1px solid ${c.border}`, backgroundColor: c.bgElevated, display: "flex", flexDirection: "column", gap: "1px", overflowY: "auto", padding: "8px", boxSizing: "border-box" },
  sectionCard: { backgroundColor: c.surface, border: `1px solid ${c.border}`, borderRadius: r.md, padding: "12px", marginBottom: "8px", display: "flex", flexDirection: "column", boxShadow: "0 1px 0 rgba(255,255,255,0.03) inset, 0 6px 16px -14px rgba(0,0,0,0.8)" },
  buttonStack: { display: "flex", flexDirection: "column", gap: "8px" },
  primaryButton: { backgroundImage: g.primary, color: "#fff", border: "1px solid rgba(129,140,248,0.4)", padding: "10px 14px", borderRadius: r.sm, fontSize: "0.8125rem", fontWeight: "600", cursor: "pointer", fontFamily: "inherit", textAlign: "left", boxShadow: "0 4px 14px -6px rgba(99,102,241,0.55)" },
  secondaryButton: { backgroundColor: c.bgElevated, color: c.textMuted, border: `1px solid ${c.border}`, padding: "10px 14px", borderRadius: r.sm, fontSize: "0.8125rem", fontWeight: "600", cursor: "pointer", fontFamily: "inherit", textAlign: "left" },
  imageBox: { height: "auto", backgroundColor: c.bg, borderRadius: r.sm, border: `1px dashed ${c.border}`, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", minHeight: "64px" },
  emptyBoxPlaceholder: { fontSize: "0.75rem", color: c.textDim },
  sidebarVideoWrapper: { position: "relative", width: "100%", aspectRatio: "16/9", backgroundColor: c.bg, borderRadius: r.sm, overflow: "hidden", border: `1px solid ${c.border}` },
  localPreviewVideo: { position: "absolute", inset: 0, display: "block", width: "100%", height: "100%", objectFit: "contain", objectPosition: "center", backgroundColor: c.bg },
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
  checkoutContactBlock: { marginBottom: "14px" },
  checkoutContactTitle: { fontSize: "11px", fontWeight: "700", color: c.textSoft, marginBottom: "4px" },
  checkoutContactHint: { fontSize: "10px", color: c.textDim, margin: "0 0 8px", lineHeight: 1.45 },
  checkoutInput: {
    width: "100%",
    boxSizing: "border-box",
    backgroundColor: c.bg,
    color: c.textSoft,
    border: `1px solid ${c.border}`,
    borderRadius: r.sm,
    padding: "8px 10px",
    fontFamily: "inherit",
    fontSize: "11px",
    marginBottom: "6px",
  },
  checkoutContactError: { fontSize: "10px", color: c.rose, marginTop: "2px" },
  creditCardGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "10px",
    alignItems: "stretch",
    width: "100%",
  },
  creditCard: {
    position: "relative",
    backgroundColor: c.bg,
    border: `1px solid ${c.border}`,
    borderRadius: "10px",
    padding: "16px 10px 12px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    gap: "4px",
    minWidth: 0,
    height: "100%",
    boxSizing: "border-box",
  },
  creditCardPopular: { border: `1px solid ${c.primary}`, boxShadow: "0 0 0 1px rgba(129,140,248,0.2)" },
  creditCardSelected: { border: `1px solid ${c.emerald || "#34d399"}`, boxShadow: "0 0 0 1px rgba(52,211,153,0.28)" },
  popularBadge: { position: "absolute", top: "-9px", left: "50%", transform: "translateX(-50%)", backgroundImage: g.primary, color: "#fff", fontSize: "8px", fontWeight: "700", padding: "2px 8px", borderRadius: r.full, letterSpacing: "0.04em", whiteSpace: "nowrap" },
  creditCardIcon: { width: "28px", height: "28px", borderRadius: "50%", backgroundColor: c.surface, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", color: c.textDim, marginBottom: "2px", flexShrink: 0 },
  creditCardIconPopular: { backgroundImage: g.primary, color: "#fff" },
  creditCardAmount: { fontSize: "14px", fontWeight: "800", fontFamily: f.sans, color: c.text, lineHeight: 1.2 },
  creditCardLabel: {
    fontSize: "9px",
    color: c.textMuted,
    lineHeight: 1.3,
    minHeight: "24px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  creditCardPrice: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "2px",
    margin: "4px 0 8px",
    width: "100%",
    minHeight: "34px",
  },
  creditCardPriceMain: {
    fontSize: "11px",
    fontWeight: "700",
    color: c.textSoft,
    lineHeight: 1.2,
    wordBreak: "break-word",
  },
  creditCardPriceSub: {
    fontSize: "9px",
    color: c.textDim,
    lineHeight: 1.2,
  },
  creditCardBuyBtn: {
    width: "100%",
    marginTop: "auto",
    backgroundColor: "transparent",
    color: c.textSoft,
    border: `1px solid ${c.border}`,
    padding: "7px 8px",
    borderRadius: r.full,
    fontSize: "11px",
    fontWeight: "600",
    cursor: "pointer",
    fontFamily: "inherit",
    minHeight: "32px",
    lineHeight: 1.2,
  },
  creditCardBuyBtnPopular: { backgroundColor: c.text, color: c.bg, border: `1px solid ${c.text}` },
  creditCardBuyBtnSelected: {
    backgroundColor: "rgba(52,211,153,0.18)",
    color: "#6ee7b7",
    border: "1px solid rgba(52,211,153,0.45)",
  },
  modalNote: { fontSize: "9px", color: c.textDim, fontStyle: "italic", marginTop: "12px", textAlign: "center" },
  sectionCardAlert: { border: `1px solid ${c.rose}`, boxShadow: "0 0 0 3px rgba(251,113,133,0.15)" },
  outputCanvas: { flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", backgroundColor: c.bg, overflow: "hidden" },
  canvasControlBar: { display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: "8px", padding: "8px 14px", borderBottom: `1px solid ${c.border}`, backgroundColor: c.bgElevated, flexShrink: 0 },
  canvasTitleGroup: { display: "flex", flexDirection: "column", gap: "1px", flex: "1 1 180px" },
  canvasTitle: { fontSize: "0.875rem", fontWeight: "700", fontFamily: fd, color: c.text, margin: 0, letterSpacing: "-0.02em" },
  canvasSubtitle: { fontSize: "0.6875rem", color: c.textDim, lineHeight: 1.4 },
  actionRow: { display: "flex", flexWrap: "wrap", gap: "6px", flex: "1 1 240px", justifyContent: "flex-end" },
  actionButton: { border: "1px solid transparent", padding: "7px 12px", borderRadius: r.sm, fontSize: "0.75rem", fontWeight: "600", cursor: "pointer", fontFamily: "inherit", letterSpacing: "-0.01em" },
  startButton: { backgroundImage: g.live, color: "#fff", boxShadow: "0 4px 14px -6px rgba(52,211,153,0.5)" },
  stopButton: { backgroundImage: g.stop, color: "#fff", boxShadow: "0 4px 14px -6px rgba(251,113,133,0.5)" },
  popOutButton: { backgroundColor: c.bgElevated, color: c.textMuted, border: `1px solid ${c.border}` },
  canvasViewportContainer: { flex: 1, minHeight: 0, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "10px 16px 12px", overflow: "auto" },
  outputColumn: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start", gap: "10px", width: "100%", maxWidth: "100%", minHeight: "min-content" },
  timerBadgeRow: { display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "center" },
  timerBadgeOutside: { backgroundColor: c.surface, border: `1px solid ${c.border}`, borderRadius: r.sm, padding: "4px 12px", fontSize: "11px", fontWeight: "700", color: c.primary, letterSpacing: "0.08em" },
  fixedOutputContainer: { backgroundColor: "#000", borderRadius: r.md, border: `1px solid ${c.border}`, position: "relative", overflow: "hidden", boxShadow: `0 24px 48px -20px rgba(0,0,0,0.8), 0 0 0 1px rgba(129,140,248,0.08)` },
  outputVideo: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
    backgroundColor: "#000",
    filter: "contrast(1.08) saturate(1.06) brightness(1.02)",
    transform: "translateZ(0)",
  },
  fittedImage: { width: "100%", height: "100%", objectFit: "contain" },
  canvasOverlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(11, 16, 32, 0.94)" },
  overlayPingWrap: { position: "relative", width: "24px", height: "24px", marginBottom: "16px", display: "flex", alignItems: "center", justifyContent: "center" },
  overlayRadarPing: { position: "absolute", width: "24px", height: "24px", borderRadius: "50%", border: `2px solid ${c.rose}`, animation: "radarPing 1.8s cubic-bezier(0.2,0.6,0.4,1) infinite" },
  overlayPingDot: { position: "absolute", width: "7px", height: "7px", borderRadius: "50%", backgroundColor: c.rose, boxShadow: "0 0 8px 1px rgba(251,113,133,0.7)" },
  overlayText: { fontSize: "0.9375rem", fontWeight: "600", fontFamily: fd, color: c.textMuted, marginBottom: "4px" },
  overlaySubtext: { fontSize: "0.8125rem", color: c.textDim, lineHeight: 1.55, textAlign: "center", maxWidth: "320px", padding: "0 16px" },
};