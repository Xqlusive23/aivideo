const GITHUB_LATEST_RELEASE_URL =
  "https://api.github.com/repos/Xqlusive23/aivideo/releases/latest";

export function parseShellVersion(value) {
  return String(value || "")
    .replace(/^v/i, "")
    .split(".")
    .map((part) => parseInt(part, 10) || 0);
}

export function isShellVersionNewer(candidate, current) {
  const next = parseShellVersion(candidate);
  const now = parseShellVersion(current);
  for (let i = 0; i < Math.max(next.length, now.length); i += 1) {
    const diff = (next[i] || 0) - (now[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

function pickWindowsInstallerAsset(assets = []) {
  return (
    assets.find((asset) => /\.exe$/i.test(asset.name) && /setup/i.test(asset.name)) ||
    assets.find((asset) => /\.exe$/i.test(asset.name)) ||
    null
  );
}

export async function fetchLatestWindowsShellRelease() {
  const response = await fetch(GITHUB_LATEST_RELEASE_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "InspireTech-Studio",
    },
  });
  if (!response.ok) {
    throw new Error(`Could not reach GitHub releases (${response.status})`);
  }

  const release = await response.json();
  const version = String(release.tag_name || "").replace(/^v/i, "");
  const asset = pickWindowsInstallerAsset(release.assets || []);

  return {
    version,
    downloadUrl: asset?.browser_download_url || "",
    releasePageUrl: release.html_url || "",
    releaseNotes: release.body || "",
    releaseDate: release.published_at || "",
  };
}

export async function checkForNewerShellRelease(currentVersion) {
  const current = String(currentVersion || "").trim();
  if (!current) return null;

  const release = await fetchLatestWindowsShellRelease();
  if (!release.version || !isShellVersionNewer(release.version, current)) {
    return null;
  }
  if (!release.downloadUrl) {
    throw new Error("Latest release has no Windows installer attached.");
  }
  return release;
}
