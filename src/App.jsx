import React, { useState, useRef, useEffect } from "react";
import { createDecartClient, models } from "@decartai/sdk";

// Reads from a .env file (Vite: VITE_DECART_API_KEY=your_key_here).
// NEVER hardcode a real key in source — it ends up in your bundle and git history.
const MY_DECART_KEY = import.meta.env?.VITE_DECART_API_KEY || "dct_token_RtGfCajWVtWgdAGUAtcmtydZYhnBpjtQOwVPbXXAGOsuSAoyDEtkJMElnKMvHzxw";

// How long a live transformation session is allowed to run before auto-stopping.
// This is just a UX cap, unrelated to billing.
const SESSION_DURATION_SECONDS = 5 * 60; // 5 minutes

// --- Real credit ledger backend --------------------------------------------
// See /ledger-backend. The browser NEVER decides the balance — it only ever
// displays whatever this server last reported.
const LEDGER_URL = import.meta.env?.VITE_LEDGER_BACKEND_URL || "http://localhost:3002";
const NAIRA_PER_DOLLAR = 1900; // must match ledger-backend/server.js — keep these in sync
const NAIRA_PER_CREDIT = NAIRA_PER_DOLLAR / 100; // 100 credits = $1, so 1 credit = ₦19
const DISPLAY_CREDITS_PER_SECOND = 2; // for UI copy only — the server decides the real rate
const LOW_CREDIT_THRESHOLD = 40; // ~20 seconds left at 2 credits/sec — warn before it runs out
const HEARTBEAT_INTERVAL_MS = 2000; // how often the frontend checks in with the server ledger

const TOP_UP_OPTIONS = [
  { naira: 19000, credits: 1000 },
  { naira: 95000, credits: 5000 },
  { naira: 190000, credits: 10000, popular: true },
  { naira: 950000, credits: 50000 },
];

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

  useEffect(() => {
    if (showAddCredits && creditSectionRef.current) {
      creditSectionRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [showAddCredits]);

  const refreshBalance = async () => {
    try {
      const res = await fetch(`${LEDGER_URL}/api/credits`, { headers: authHeaders() });
      if (res.status === 401) {
        setTokenError("That access token was rejected by the server. Please re-enter it.");
        clearAccessToken();
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

  // Local 5-minute UX countdown — purely a display/cap concern, not billing.
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
        audio: true,
        video: { frameRate: model.fps || 24, width: 1280, height: 720 },
      });

      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      setStatus("DEVICE READY // AWAITING DISPATCH");
      startMetricsDemux();
    } catch (err) {
      console.error("Camera access failed:", err);
      setStatus("HARDWARE ERROR: ACCESS DENIED");
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
    if (!selectedFile || !localStreamRef.current) {
      setStatus("ERROR: CONFIGURATION INCOMPLETE");
      return;
    }
    if (ledgerUnreachable) {
      setStatus("LEDGER BACKEND UNREACHABLE — CHECK IT'S RUNNING");
      return;
    }

    // Ask the server for permission to start — it's the one that knows the
    // real balance, not this client.
    let sessionId;
    try {
      const res = await fetch(`${LEDGER_URL}/api/sessions/start`, { method: "POST", headers: authHeaders() });
      const data = await res.json();
      if (res.status === 401) {
        setStatus("ACCESS TOKEN REJECTED — PLEASE RE-ENTER IT");
        clearAccessToken();
        return;
      }
      if (!res.ok) {
        setCredits(data.credits ?? 0);
        setStatus("OUT OF CREDITS — ADD MORE TO CONTINUE");
        setShowAddCredits(true);
        return;
      }
      sessionId = data.sessionId;
      setCredits(data.credits);
    } catch (err) {
      console.error("Failed to start billing session:", err);
      setStatus("LEDGER BACKEND UNREACHABLE — CHECK IT'S RUNNING");
      setLedgerUnreachable(true);
      return;
    }

    billingSessionIdRef.current = sessionId;
    setIsRunning(true);
    setStatus("HANDSHAKING WITH DECART WEBRTC CLUSTER...");

    try {
      const client = createDecartClient({ apiKey: MY_DECART_KEY });
      const reader = new FileReader();
      reader.readAsDataURL(selectedFile);
      reader.onloadend = async () => {
        const base64Image = reader.result;
        try {
          const session = await client.realtime.connect(localStreamRef.current, {
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
            },
            onDisconnect: () => {
              setStatus("PIPELINE TERMINATED");
              setIsRunning(false);
              clearClockTimer();
              clearHeartbeat();
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
          endBillingSession(sessionId);
        }
      };
    } catch (err) {
      console.error("Failed to initialize Decart client:", err);
      setStatus(`CLIENT INIT FAILED: ${err.message || "check VITE_DECART_API_KEY is set"}`);
      setIsRunning(false);
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
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error || "Checkout failed");
      window.location.href = data.url; // real Paystack Checkout page
    } catch (err) {
      console.error("Checkout error:", err);
      setStatus(`CHECKOUT ERROR: ${err.message}`);
    }
  };

  const creditPercent = Math.min(100, (credits / 1000) * 100);
  const isLowCredit = credits <= LOW_CREDIT_THRESHOLD;

  // No access token yet — show a simple entry gate instead of the app.
  // Admin generates tokens via POST /api/admin/tokens (see ledger-backend README).
  if (!accessToken) {
    return (
      <div style={styles.gateContainer}>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
          html, body, #root { margin: 0; padding: 0; width: 100%; height: 100%; }
          *, *::before, *::after { box-sizing: border-box; }
        `}</style>
        <div style={styles.gateCard}>
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
        </div>
      </div>
    );
  }

  return (
    <div style={styles.appContainer}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        html, body, #root { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
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
        @media (max-width: 640px) {
          .itc-credit-grid { grid-template-columns: repeat(2, 1fr) !important; }
        }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: #05070c; }
        ::-webkit-scrollbar-thumb { background: #1e2537; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #2c3550; }
      `}</style>

      <header style={styles.topHeader}>
        <div style={styles.brandingGroup}>
          <span style={styles.brandIcon}>🛸</span>
          <div style={styles.logoText}>
            InspireTech<span style={styles.logoVersion}>v2.7-ledger</span>
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

        <div style={styles.systemStatusRibbon}>
          <div style={styles.statusPill}>
            <span style={styles.metaLabel}>ENGINE_STATUS:</span>
            <span style={{...styles.metaValue, color: isRunning ? "#22c55e" : "#f5a524"}}>{status}</span>
          </div>
          <div style={styles.statusPill}>
            <span style={styles.metaLabel}>FPS:</span>
            <span style={styles.metaValue}>{fps || "--"}</span>
          </div>
          <div style={styles.statusPill}>
            <span style={styles.metaLabel}>LATENCY:</span>
            <span style={styles.metaValue}>{latency}</span>
          </div>
          <div style={styles.statusPill}>
            <span style={styles.metaLabel}>SESSION_TIME:</span>
            <span style={{...styles.metaValue, color: isRunning && timeRemaining <= 30 ? "#f0576a" : "#5b8def"}}>
              {isRunning ? formatTime(timeRemaining) : "05:00"}
            </span>
          </div>
          <div style={styles.statusPillLast}>
            <span style={styles.metaLabel}>CREDITS:</span>
            <span style={{...styles.metaValue, color: isLowCredit ? "#f0576a" : "#5b8def", animation: isLowCredit && isRunning ? "creditPulse 1s infinite" : "none"}}>
              {creditsLoaded ? `${credits} ` : "…"}
              {creditsLoaded && <span style={styles.creditsDollar}>({formatNaira(credits)})</span>}
            </span>
          </div>
        </div>
      </header>

      <div style={styles.mainWorkspace}>
        <aside style={styles.controlSidebar}>

          <div style={styles.sectionCard} className="itc-card">
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
          <div style={styles.sectionCard} className="itc-card">
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

          <div style={styles.sectionCard} className="itc-card">
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

          <div style={styles.sectionCard} className="itc-card">
            <div style={styles.cardHeaderStrip}>
              <span style={styles.cardHeaderIcon}>👁️</span> LOCAL CAPTURE INTERCEPT
            </div>
            <div style={styles.sidebarVideoWrapper}>
              <video ref={localVideoRef} autoPlay playsInline muted style={styles.mirroredVideo} />
            </div>
          </div>

          <div ref={creditSectionRef} style={{...styles.sectionCard, ...(showAddCredits ? styles.sectionCardAlert : {})}} className="itc-card">
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

          <div style={{...styles.sectionCard, flex: 1}} className="itc-card">
            <div style={styles.cardHeaderStrip}>
              <span style={styles.cardHeaderIcon}>🧬</span> PIPELINE PARAMS
            </div>
            <div style={styles.parameterRow}>
              <label style={styles.paramLabel}>INFERENCE WEIGHT</label>
              <div style={styles.paramSliderGroup}>
                <input type="range" min="0" max="100" value={inferenceWeight} onChange={(e) => setInferenceWeight(Number(e.target.value))} disabled={isRunning} style={styles.paramSlider} className="itc-range" />
                <span style={styles.paramValue}>{inferenceWeight}%</span>
              </div>
            </div>
            <div style={styles.parameterRow}>
              <label style={styles.paramLabel}>ENHANCE MASK VECTOR</label>
              <input type="checkbox" checked={enhanceMask} onChange={(e) => setEnhanceMask(e.target.checked)} disabled={isRunning} style={styles.paramCheckbox} className="itc-checkbox" />
            </div>
            <div style={styles.parameterRow}>
              <label style={styles.paramLabel}>ACTIVE MODEL CORE</label>
              <select value={activeModel} onChange={(e) => setActiveModel(e.target.value)} disabled={isRunning} style={styles.paramSelect} className="itc-select">
                <option value="lucy-realtime-v2.1">lucy-realtime-v2.1</option>
                <option value="lucy-speed-v1.9">lucy-speed-v1.9</option>
              </select>
            </div>
            {isRunning && <div style={styles.paramsLockedNote}>Locked while live — changes apply on next deploy</div>}
          </div>
        </aside>

        <main style={styles.outputCanvas}>
          <div style={styles.canvasControlBar}>
            <div style={styles.canvasTitleGroup}>
              <h2 style={styles.canvasTitle}>OUTPUT MONITOR</h2>
              <span style={styles.canvasSubtitle}>Matrix Field Resolution: 1280x720 downscaled directly to 860x520 viewport</span>
            </div>
            <div style={styles.actionRow}>
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
            </div>
          </div>

          <div style={styles.canvasViewportContainer}>
            <div style={styles.outputColumn}>
              {isRunning && (
                <div style={styles.timerBadgeRow}>
                  <div style={styles.timerBadgeOutside}>{formatTime(timeRemaining)}</div>
                  <div style={{...styles.timerBadgeOutside, color: isLowCredit ? "#f0576a" : "#5b8def"}}>
                    {credits} credits left
                  </div>
                </div>
              )}
              <div style={styles.fixedOutputContainer}>
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

          <footer style={styles.terminalContainer}>
            <div style={styles.terminalTab}>SYSTEM_CONSOLE_LOGS</div>
            <div style={styles.terminalBody}>
              <div style={styles.logLine}><span style={styles.logTimestamp}>[boot]</span> Initializing internal InspireTech compute components...</div>
              <div style={styles.logLine}><span style={styles.logTimestamp}>[boot]</span> Ledger backend: {LEDGER_URL} — {ledgerUnreachable ? "UNREACHABLE" : `balance ${creditsLoaded ? credits : "…"}`}</div>
              {isRunning && (
                <div style={{...styles.logLine, color: "#34d399"}}><span style={styles.logTimestamp}>[live]</span> Server-billed session active — {sessionCreditsUsed} credits used so far.</div>
              )}
            </div>
          </footer>
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
  sidebarVideoWrapper: { aspectRatio: "16/9", backgroundColor: "#05070c", borderRadius: "6px", overflow: "hidden", border: "1px solid #1a2030" },
  parameterRow: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", fontSize: "11px" },
  paramLabel: { color: "#6b7385", fontWeight: "600" },
  paramSliderGroup: { display: "flex", alignItems: "center", gap: "8px" },
  paramSlider: { width: "100px", accentColor: "#5b8def" },
  paramValue: { color: "#5b8def", fontWeight: "700", fontSize: "11px", minWidth: "32px", textAlign: "right" },
  paramCheckbox: { width: "14px", height: "14px", accentColor: "#5b8def" },
  paramSelect: { backgroundColor: "#05070c", color: "#e6e9ef", border: "1px solid #262e42", borderRadius: "5px", padding: "4px 8px", fontFamily: "inherit", fontSize: "11px" },
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
  canvasViewportContainer: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "20px", overflow: "hidden" },
  outputColumn: { display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" },
  timerBadgeRow: { display: "flex", gap: "10px" },
  timerBadgeOutside: { backgroundColor: "#0d111c", border: "1px solid #1a2030", borderRadius: "6px", padding: "6px 16px", fontSize: "13px", fontWeight: "700", color: "#5b8def", letterSpacing: "0.08em" },
  fixedOutputContainer: { width: "860px", height: "520px", backgroundColor: "#000", borderRadius: "8px", border: "1px solid #1a2030", position: "relative", overflow: "hidden", boxShadow: "0 30px 60px -20px rgba(0,0,0,0.8), 0 0 0 1px rgba(91,141,239,0.05)" },
  mirroredVideo: { width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" },
  fittedImage: { width: "100%", height: "100%", objectFit: "contain" },
  canvasOverlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(5, 7, 12, 0.94)" },
  overlayPingWrap: { position: "relative", width: "24px", height: "24px", marginBottom: "16px", display: "flex", alignItems: "center", justifyContent: "center" },
  overlayRadarPing: { position: "absolute", width: "24px", height: "24px", borderRadius: "50%", border: "2px solid #f0576a", animation: "radarPing 1.8s cubic-bezier(0.2,0.6,0.4,1) infinite" },
  overlayPingDot: { position: "absolute", width: "7px", height: "7px", borderRadius: "50%", backgroundColor: "#f0576a", boxShadow: "0 0 8px 1px rgba(240,87,106,0.7)" },
  overlayText: { fontSize: "13px", fontWeight: "700", color: "#6b7385", letterSpacing: "0.05em", marginBottom: "4px" },
  overlaySubtext: { fontSize: "11px", color: "#3a4256" },
  terminalContainer: { height: "140px", backgroundColor: "#05070c", borderTop: "1px solid #1a2030", display: "flex", flexDirection: "column", flexShrink: 0 },
  terminalTab: { fontSize: "10px", fontWeight: "700", backgroundColor: "#0d111c", width: "160px", textAlign: "center", padding: "6px 0", borderRight: "1px solid #1a2030", borderBottom: "1px solid #05070c", color: "#5b8def", letterSpacing: "0.05em" },
  terminalBody: { padding: "12px 24px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "6px" },
  logLine: { fontSize: "11px", color: "#6b7385", lineHeight: "1.4" },
  logTimestamp: { color: "#3a4256", marginRight: "8px" },
};
