# Fonts served by the index

The index's two pages use the three faces of the project's site. All three are licensed under the SIL Open Font License 1.1. The index serves its own copies, so its pages load no font from any other host.

| File | Face | Copyright | Source |
| --- | --- | --- | --- |
| `routed-gothic.ttf` | Routed Gothic | 2017 Darren Embry, Reserved Font Name Routed Gothic | https://webonastick.com/fonts/routed-gothic/ |
| `hanken-grotesk.woff2` | Hanken Grotesk, variable weight 400 to 700, latin subset | 2020 The Hanken Grotesk Project Authors | https://github.com/marcologous/hanken-grotesk |
| `spline-sans-mono.woff2` | Spline Sans Mono, variable weight 400 to 600, latin subset | 2022 The Spline Sans Mono Project Authors | https://github.com/SorkinType/SplineSansMono |

Each file is the one in `site/public/fonts/`, byte for byte, and carries its copyright notice and the license's address in its own metadata. `LICENSE.md` is the OFL text as shipped with Routed Gothic; the same license applies to the other two.

`npm run build` copies the three font files to `dist/page/fonts/`. The Worker serves a font and no other file of this folder.
