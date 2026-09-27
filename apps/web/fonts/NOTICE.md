# Self-hosted web fonts

All fonts here are licensed under the SIL Open Font License 1.1. The license text is in
`LICENSE.txt`.

| File                                                                        | Family            | Copyright                                                                                            |
| --------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------- |
| `Geist-Variable.woff2`, `GeistMono-Variable.woff2`                          | Geist, Geist Mono | Copyright (c) 2023 Vercel, in collaboration with basement.studio                                     |
| `SplineSans-Variable-latin.woff2`                                           | Spline Sans       | Copyright 2021 The Spline Sans Project Authors (https://github.com/SorkinType/SplineSans)            |
| `SplineSansMono-Variable-latin.woff2`                                       | Spline Sans Mono  | Copyright 2022 The Spline Sans Mono Project Authors (https://github.com/SorkinType/SplineSansMono)   |
| `Inter-Variable-latin.woff2`                                                | Inter             | Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)                             |
| `InstrumentSerif-Regular-latin.woff2`, `InstrumentSerif-Italic-latin.woff2` | Instrument Serif  | Copyright 2022 The Instrument Serif Project Authors (https://github.com/Instrument/instrument-serif) |

The `*-latin.woff2` files (#2397) are the exact latin-subset files Google Fonts served to
`next/font/google` (fonts.gstatic.com: splinesans v16, splinesansmono v13, inter v20,
instrumentserif v5). They are self-hosted so the web build never fetches fonts from Google.
