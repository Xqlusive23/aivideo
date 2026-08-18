/** Shared anti-bleed clause for full-frame background replacement (no webcam room visible). */
const FULL_FRAME_CLAUSE =
  "The new environment must fill 100% of the frame behind the person edge to edge with photorealistic depth, razor-sharp detail, and consistent lighting that matches the subject; completely erase every pixel of the original webcam room, walls, furniture, bedding, and ambient light with zero bleed-through, ghosting, halos, color spill, or visible edges from the live camera feed.";

/** Extra clarity for hotel/office scenes (matches premium compositing in reference output). */
const CLARITY_CLAUSE =
  "Render crisp textures on walls, fabrics, and furniture; keep the person razor-sharp with defined facial features, hair, and clothing edges; use natural depth of field, accurate perspective, and seamless edge blending around hair and shoulders so the subject appears physically present in the scene.";

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

/** Curated scene presets with photoreal preview art and Decart-optimized prompts. */
export const BACKGROUND_SCENES = [
  {
    id: "presidential-suite",
    label: "Presidential suite",
    tagline: "Ultra-luxury penthouse",
    category: "Hotels",
    image: "/backgrounds/presidential-suite.jpg",
    prompt: `Change the background to an ultra-luxury presidential suite with floor-to-ceiling windows, marble floors, a crystal chandelier, designer lounge seating, rich gold-and-cream tones, and soft warm evening city glow through the windows. ${FULL_FRAME_CLAUSE} ${CLARITY_CLAUSE}`,
  },
  {
    id: "premium-business-hotel",
    label: "Premium business hotel room",
    tagline: "Warm executive stay",
    category: "Hotels",
    image: "/backgrounds/premium-business-hotel.jpg",
    prompt: `Change the background to a premium business hotel room with a king bed, plush headboard, warm amber bedside lamps, floor-to-ceiling curtains, a sleek desk, and soft golden ambient lighting that fills the entire frame behind the person. ${FULL_FRAME_CLAUSE} ${CLARITY_CLAUSE}`,
  },
  {
    id: "executive-ceo-office",
    label: "Executive CEO office",
    tagline: "Corner suite workspace",
    category: "Offices",
    image: "/backgrounds/executive-ceo-office.jpg",
    prompt: `Change the background to an executive CEO corner office with floor-to-ceiling glass, a large wooden desk, leather chair, city skyline view, indoor plants, and polished professional lighting. ${FULL_FRAME_CLAUSE} ${CLARITY_CLAUSE}`,
  },
  {
    id: "corporate-meeting-room",
    label: "Corporate meeting room",
    tagline: "Boardroom ready",
    category: "Offices",
    image: "/backgrounds/corporate-meeting.jpg",
    prompt: `Change the background to a modern corporate meeting room with a long conference table, ergonomic chairs, glass walls, subtle recessed lighting, and a clean professional atmosphere. ${FULL_FRAME_CLAUSE} ${CLARITY_CLAUSE}`,
  },
  {
    id: "sunset-beach",
    label: "Sunset beach",
    tagline: "Golden hour coast",
    category: "Outdoor",
    image: "/backgrounds/sunset-beach.jpg",
    prompt: `Change the background to a tropical beach at golden hour with gentle waves, wet sand reflections, palm silhouettes, and warm orange-pink sky gradients. ${FULL_FRAME_CLAUSE} ${CLARITY_CLAUSE}`,
  },
  {
    id: "broadcast-studio",
    label: "Broadcast studio",
    tagline: "Pro key-lit set",
    category: "Studio",
    image: "/backgrounds/broadcast-studio.jpg",
    prompt: `Change the background to a professional broadcast studio with soft key lighting, subtle gradient backdrop, clean floor, and polished on-air production look. ${FULL_FRAME_CLAUSE} ${CLARITY_CLAUSE}`,
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
