# Mobile store release (App Store + Google Play)

Epic #2307 · build config #2312 · listing content #2313.

The single Expo app in `apps/mobile` (every role) ships to the Apple App Store and Google Play from
the `production` profile in `apps/mobile/eas.json`. Everything below is run by the **owner** from
their own machine. Agents never run `eas build`, `eas submit` or `eas update`.

## 1. Secrets: where they live (never in git)

| Item                                                           | Where                                                                                        | Notes                                                                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Google Play service-account JSON                               | `apps/mobile/secrets/google-play-service-account.json`                                       | `apps/mobile/secrets/` is gitignored. `eas.json` `submit.production.android.serviceAccountKeyPath` points here. |
| App Store Connect app id (`ascAppId`) and Apple ID (`appleId`) | answered at the `eas submit` prompt, or added to a **local, uncommitted** copy of `eas.json` | Not stored in the repo (epic #2307).                                                                            |
| `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY`                              | an EAS **environment variable** for the `preview` and `production` environments              | `app.config.js` injects it. The production profile now **refuses to build** without it (#2312).                 |
| Store reviewer credentials (`routeflow-demo` tenant)           | typed into the App Store / Play review notes **only**                                        | Never in the repo, docs or code map.                                                                            |

Set the maps key with the EAS CLI's environment commands (`eas env:create --help`), once for
`preview` and once for `production`, with sensitive visibility.

## 2. Version numbers (seed once, before the first production build)

`eas.json` uses `"appVersionSource": "remote"` and the `production` profile has
`"autoIncrement": true`, so EAS owns the build number / versionCode. Seed them **above anything
already installed** before the first production build:

- **Android:** the internal staging APK is at `versionCode` 6. Seed the remote versionCode to at
  least **7** (`eas build:version:set --platform android`).
- **iOS:** no store build exists yet; seed the build number (e.g. **1**) with
  `eas build:version:set --platform ios` if EAS asks.

The marketing version (`expo.version`, currently `1.1.1` in `app.json`) is still set in the repo.
`runtimeVersion.policy: appVersion` ties OTA updates to it.

## 3. First builds

1. iOS: a `production` build, submitted to **TestFlight** first (epic #2307).
2. Android: a `production` build submitted to the Play **internal** track
   (`submit.production.android.track`), then promoted in the Play Console.

## 4. Pre-flight checks (done for #2312)

- `apps/mobile/assets/icon.png`: 1024 × 1024, RGB, **no alpha**. ✅ (App Store requirement.)
- Bundle id / package: `com.routeflow.mobile` on both platforms (`app.json`).
- iPad: `ios.supportsTablet: true` (owner decision: iPad in the first release).

## 5. Store decisions (owner, recorded on #2312)

1. **iOS background location: yes, match Android.** `lib/location-tracker.native.ts` requests
   background permission and calls `Location.startLocationUpdatesAsync` through a TaskManager task
   on every platform, so `app.json`'s expo-location plugin sets `"isIosBackgroundLocationEnabled":
true` (the existing "Always" usage string is reused). **App Review note:** "Dispatch tracks
   active delivery runs only." The same note is in #2313's review-notes template.
2. **iPad: no `UIRequiresFullScreen`** (#2311 PR 1). `"orientation": "portrait"` locks only the
   iPhone: `npx expo config --type introspect` (run in `apps/mobile`) shows
   `UISupportedInterfaceOrientations~ipad` = all four orientations and `UIRequiresFullScreen` =
   false, so iPad multitasking is valid and ITMS-90474 does not apply. Re-run that command before a
   store build if `orientation` or `ios.infoPlist` ever changes.

## 6. Owner checklist (from epic #2307)

- Play Console account (Organization, with a D-U-N-S number, avoids the 12-tester / 14-day
  closed-test rule for personal accounts).
- Privacy and support URLs: `https://www.routeflow.info/privacy`, `https://www.routeflow.info/terms`.
- Play's Background Location declaration (with a video) and the Data Safety form.
- Apple's App Privacy label (Sentry, push notifications, maps, location). Listing text and privacy
  answers are drafted in #2313.
