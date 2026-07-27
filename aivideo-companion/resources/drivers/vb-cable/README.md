Place the **full extracted** VB-CABLE Windows package here before building the desktop app.

Required files include:

- `VBCABLE_Setup_x64.exe` (preferred on 64-bit Windows)
- at least one `*.inf` driver file (e.g. `vbMmeCable64_win7.inf`)

Download from https://vb-audio.com/Cable/ (donationware), extract the ZIP to a normal folder, then copy **all** extracted files here — not just the `.exe`.

`npm run prepare:drivers` can download and extract the official package automatically when `.inf` files are missing.

Bundling VB-CABLE requires following VB-Audio's distribution terms:
https://vb-audio.com/Services/licensing.htm

The desktop setup wizard copies the package to a temp folder, clears Mark-of-the-Web blocks, then runs the installer elevated. Windows may still show a driver security prompt — users must approve it. Reboot if prompted.
