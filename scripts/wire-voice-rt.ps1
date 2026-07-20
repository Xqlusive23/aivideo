param(
  [Parameter(Mandatory = $true)]
  [string]$Url
)

$ErrorActionPreference = "Stop"
$Url = $Url.TrimEnd("/")

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$targets = @(
  @{ Path = Join-Path $root "ledger-backend\.env"; Key = "VOICE_RT_URL" },
  @{ Path = Join-Path $root ".env"; Key = "VITE_VOICE_RT_URL" },
  @{ Path = Join-Path $root ".env.production"; Key = "VITE_VOICE_RT_URL" }
)

foreach ($t in $targets) {
  if (-not (Test-Path $t.Path)) {
    Write-Warning "Skip missing file: $($t.Path)"
    continue
  }
  $lines = Get-Content $t.Path
  $found = $false
  $out = foreach ($line in $lines) {
    if ($line -match "^\s*$([regex]::Escape($t.Key))\s*=") {
      $found = $true
      "$($t.Key)=$Url"
    } else {
      $line
    }
  }
  if (-not $found) {
    $out += "$($t.Key)=$Url"
  }
  Set-Content -Path $t.Path -Value $out -Encoding UTF8
  Write-Host "Updated $($t.Key) in $($t.Path)"
}

Write-Host ""
Write-Host "Done. Next:"
Write-Host "  1. Railway -> VOICE_RT_URL=$Url"
Write-Host "  2. npm run build && vercel deploy --prebuilt --prod --yes"
Write-Host "  3. curl.exe $Url/health"
