# Fonts

Four Inter faces, bundled so `build.mjs` can embed them and the render stops depending on
what is installed on the machine.

**Inter** — https://github.com/rsms/inter, v4.1, licensed **SIL Open Font License 1.1**.
The OFL permits bundling and embedding, including the subset a PDF export creates.

**`OFL.txt` is the license text, and it must stay beside the fonts.** The OFL requires it to
accompany the font files in any redistribution, and this repo redistributes them the moment
it is cloned or published. Copied from the `v4.1` tag of rsms/inter; the file is identical on
the `v4.1` tag and on `master`, so it does not drift with the upstream default branch.

If the faces are ever replaced, re-copy `LICENSE.txt` from the matching release rather than
assuming this copy still applies. The bundled faces report **Version 4.001** in their name
table, which is rsms's internal numbering for the v4.1 release — that is how you check the
license and the binaries are from the same place.

An unlicensed font in a public repo is a distribution blocker, not a documentation gap.

## Why they are in the repo rather than installed

A render that relies on Inter being installed fails **silently**. On Windows a per-user
install — `%LOCALAPPDATA%\Microsoft\Windows\Fonts` plus an `HKCU` registry value — only
becomes visible to Chromium after `AddFontResourceW` is called per file and `WM_FONTCHANGE`
is broadcast, and that registration is **session-scoped**: the registry entry survives a
reboot, the visibility does not. The CSS fallback chain then does exactly its job and the
document is simply in the wrong typeface. Decision 006 chose the typography; a machine-local
install is not a durable way to hold it.

Only the four **RIBBI** faces are here — Regular, Bold, Italic, BoldItalic. That is
deliberate: a variable font registers under its own family name (`Inter Variable`), as do
weight-specific files (`Inter-Medium.ttf` → `Inter Medium`), so CSS asking for `Inter`
matches none of them. Adding more faces means adding matching `@font-face` rules in
`build.mjs`, not just dropping files here.

## What reads them

`src/build.mjs` only. It base64-encodes each face into an `@font-face` rule at render time,
so the HTML carries about 2.2MB while the PDF subsets to the glyphs actually used.

If this directory is missing, the render still succeeds in the CSS fallback and prints a
warning. A missing font must never be a failed render, but it must never be quiet either.

`docgen.mjs` is unaffected — `.docx` names fonts rather than embedding them, and Google Docs
has Inter natively.
