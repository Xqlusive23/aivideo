/** Curated scene presets with photoreal preview art and short Decart prompts. */
export const OUTPUT_QUALITY_OPTIONS = [
  {
    id: "1080p",
    label: "Full HD",
    subtitle: "1080p · maximum clarity",
    resolution: "1080p",
    virtualWidth: 1920,
    virtualHeight: 1080,
  },
  {
    id: "720p",
    label: "HD",
    subtitle: "720p · balanced quality",
    resolution: "720p",
    virtualWidth: 1280,
    virtualHeight: 720,
  },
  {
    id: "480p",
    label: "Balanced",
    subtitle: "480p · smoother on slower networks",
    resolution: "480p",
    virtualWidth: 854,
    virtualHeight: 480,
  },
  {
    id: "360p",
    label: "Performance",
    subtitle: "360p · lowest latency",
    resolution: "360p",
    virtualWidth: 640,
    virtualHeight: 360,
  },
];

export const OUTPUT_QUALITY_STORAGE_KEY = "itc-output-quality";

export function getOutputQualityConfig(qualityId) {
  return OUTPUT_QUALITY_OPTIONS.find((option) => option.id === qualityId) || OUTPUT_QUALITY_OPTIONS[1];
}

export function readStoredOutputQuality() {
  if (typeof window === "undefined") return "720p";
  const stored = String(window.localStorage.getItem(OUTPUT_QUALITY_STORAGE_KEY) || "").trim();
  return getOutputQualityConfig(stored).id;
}

/** Short scene prompts — Lucy enhance expands them; long stacks weaken/break edits. */
export const BACKGROUND_SCENES = [
  {
    id: "presidential-suite",
    label: "Presidential suite",
    tagline: "Ultra-luxury penthouse",
    category: "Hotels",
    image: "/backgrounds/presidential-suite.jpg",
    prompt:
      "Change the background to an ultra-luxury presidential suite with floor-to-ceiling windows, marble floors, a crystal chandelier, and warm evening city glow.",
  },
  {
    id: "premium-business-hotel",
    label: "Premium business hotel room",
    tagline: "Warm executive stay",
    category: "Hotels",
    image: "/backgrounds/premium-business-hotel.jpg",
    prompt:
      "Change the background to a premium business hotel room with a king bed, warm amber lamps, floor-to-ceiling curtains, and soft golden lighting.",
  },
  {
    id: "executive-ceo-office",
    label: "Executive CEO office",
    tagline: "Corner suite workspace",
    category: "Offices",
    image: "/backgrounds/executive-ceo-office.jpg",
    prompt:
      "Change the background to an executive CEO corner office with floor-to-ceiling glass, a large wooden desk, leather chair, and city skyline view.",
  },
  {
    id: "corporate-meeting-room",
    label: "Corporate meeting room",
    tagline: "Boardroom ready",
    category: "Offices",
    image: "/backgrounds/corporate-meeting.jpg",
    prompt:
      "Change the background to a modern corporate meeting room with a long conference table, glass walls, and clean professional lighting.",
  },
  {
    id: "sunset-beach",
    label: "Sunset beach",
    tagline: "Golden hour coast",
    category: "Outdoor",
    image: "/backgrounds/sunset-beach.jpg",
    prompt:
      "Change the background to a tropical beach at golden hour with gentle waves, wet sand, palm silhouettes, and a warm orange-pink sky.",
  },
  {
    id: "broadcast-studio",
    label: "Broadcast studio",
    tagline: "Pro key-lit set",
    category: "Studio",
    image: "/backgrounds/broadcast-studio.jpg",
    prompt:
      "Change the background to a professional broadcast studio with soft key lighting and a subtle gradient backdrop.",
  },
];

/** @deprecated Use BACKGROUND_SCENES — kept for any legacy references. */
export const PROMPT_PRESETS = BACKGROUND_SCENES.map(({ label, prompt: text }) => ({ label, text }));

export const SCENE_APPLY_TARGET_MS = 2000;

/** Higher prompt weight for scene swaps — stronger full-frame background lock-in. */
export const SCENE_INFERENCE_WEIGHT = 98;

export function findBackgroundScene(sceneId) {
  return BACKGROUND_SCENES.find((scene) => scene.id === sceneId) || null;
}

export const STUDIO_NAV_SECTIONS = [
  { id: "studio", label: "Studio", icon: "🎬" },
  { id: "credits", label: "Credits", icon: "💳" },
  { id: "drivers", label: "Drivers", icon: "🖥️", desktopOnly: true },
  { id: "account", label: "Account", icon: "⚙️" },
];

export const STUDIO_PANEL_SECTIONS = new Set(["devices", "studio", "voice"]);

export function studioNavSections(isDesktopApp) {
  return STUDIO_NAV_SECTIONS.filter((section) => !section.desktopOnly || isDesktopApp);
}

export function studioSectionTitle(sectionId) {
  return STUDIO_NAV_SECTIONS.find((section) => section.id === sectionId)?.label || "Studio";
}
