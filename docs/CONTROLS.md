# Hyperspace — controls

Every screen is keyboard-first; the mouse also works.

Fastest start: `Enter` on the title, `Space` + `Enter` on the safety screen, `Enter` on the setup (defaults:
strong, difficult passages on, the built-in room, neutral answers), then hold `Space` when the ring turns cyan.

| Where | Key | Action |
|---|---|---|
| Title | `↑` `↓`, `Enter` | move the `>` marker, select |
| Title | `P` / `A` | past sessions / about |
| Past sessions | `↑` `↓`, `Enter`, `D`, `Esc` / `T` | move, open that session's report, download that session's report as a .zip (rows with a report), back |
| Safety screen | `Space`, `Enter`, `Esc` | tick the photosensitivity box (or click the line), continue (only when ticked), exit to the title |
| Setup | `1`–`4`, `←` `→`, click a card | dose step: threshold · light · strong (default) · breakthrough |
| Setup | `G` | difficult passages on ↔ gentle mode |
| Setup | `O` / drop a photo anywhere / click the box, `X` | choose a room photo (a 2:1 photo is used as a panorama), remove it (back to the built-in room) |
| Setup | `D` | more questions (optional) |
| Setup | `Enter` / `Esc` | begin / back to the title |
| More questions | `↑` `↓` | move between rows |
| More questions | `←` `→`, `0`–`9` | sliders: move, set directly (`0` = the low end) |
| More questions | `←` `→`, `1`–`n`, `Space` | choices: change; motifs: move, tick |
| More questions | `Enter` or `Esc` | back to the setup, answers kept |
| Settling / the hit | breathe; then hold `Space` (or the on-screen button) | one screen: while the session is prepared the circle breathes slowly ("almost…" if you press Space early); when the ring turns cyan, hold to inhale for up to 4 s; a shorter hold is a partial dose |
| Settling / the hit | `Esc` | back to the title |
| Trip | `Esc` or the faint `[ESC] EXIT` corner | end the session at any moment: 3-second fade to your room, then grounding (no confirmation) |
| Trip | `E` | eyes open / closed (auto by default: they close as the visuals deepen) |
| Trip | hold `Space` | let go (helps a difficult passage resolve) |
| Trip | `H` (hold) or the faint `[H] HIT` button | repeat hit: at most 3, only while visual intensity is below 3 ("Too deep to hold the pipe.") |
| Trip | `I` | heads-up display: plasma and the three channels, relative to the half-effect level |
| Trip | mouse | look around a little (slow, clamped) |
| Any screen | `-` / `+` (also `_` / `=`) | sound volume down / up in 10 % steps ("VOL nn%" shows briefly in the corner); works once the session's sound exists (after the hit) |
| Grounding | any key | continue (after 10 s) |
| Curve | draw with mouse/touch, `C`, `Enter` | clear, done, then continue |
| End screen | `R` `D` `P` `N` `T` | read report, download the report as a .zip (report.html, Markdown, stats, snapshots, figures; waits for the report first, the page stays), replay, new session, title |
| Report page | `D` `P` `R` `T` | download .zip, print, replay, title (the offline `report.html` inside the zip only has `P`) |

URL parameters for testing (none of them affects the safety limiter): `?debug=1` (scrubber),
`?timewarp=N`, `?seed=<int>`, `?autostart=1`, `?autofill=neutral|gentle`, `?dose=<step>`, `?gentle=1`,
`?replay=<id>`, `?demoEnd=<id>`.
