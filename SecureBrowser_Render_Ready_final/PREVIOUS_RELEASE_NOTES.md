# Secure Browser — Apple Safari fallback

The existing Secure Browser UI, tabs, Secure Search, Input Summary, and Netlify proxy are retained.

## What changed

- Removed the ▤ reader button, reader menu, reader route in normal tab navigation, and reader activation. Broken websites are no longer rearranged or reloaded into a reader view.
- When a proxied page reports failed CSS/scripts, a high-confidence unstyled layout, or a proxy error, iPhone/iPad **Add to Home Screen** mode displays a full-height fallback screen with **Open in Safari**.
- Open in Safari is a *real external hyperlink*. Apple's Home Screen web-app behavior opens out-of-scope links in Safari View Controller, which has a native **Done** button to return to Secure Browser. Keep the supplied `manifest.webmanifest` (`scope: "/"`) deployed alongside the HTML.
- The ↗ toolbar link always opens the original webpage without proxying.
- **Limits:** The parent iframe cannot reliably detect every blocked or visually corrupted webpage. Safari may block programmatic popups when no user tap occurred, so a manual Open in Safari tap is used for failure detected later. Some iOS versions/settings may handle external links differently. This is not a custom Safari implementation or permission to close Safari from JavaScript.

## Deployment

Deploy this complete project with Netlify Git deployment or CLI, including its serverless functions. After deployment, on iOS open Secure Browser in Safari, then Share → Add to Home Screen, choose **Open as Web App**, and launch it from the new icon. Check any existing service-worker or browser caching by reloading if the old UI appears.

## Note

Neither the Netlify proxy nor browser assets can make every modern website work inside an iframe. The Safari fallback displays the real target webpage at its real origin instead.

## YouTube: automatic Safari opening on Apple Home Screen

- On **iPhone/iPad installed as a Home Screen web app**, tapping YouTube from the start page, bookmarks, results, or entering a YouTube address automatically launches the **original YouTube URL** outside the proxy whenever iOS allows that navigation.
- Direct YouTube search result links use normal HTTPS links rather than delayed postMessages to retain user activation, so YouTube Home, channels, Shorts, playlists, search, and video playback are handled by Safari itself.
- Other pages keep the existing Secure Browser tabs, search and proxy; non-Apple browser behavior is unchanged.
- If Safari refuses an automatic popup (particularly navigation originating after an asynchronous iframe message), a **Open in Safari** link remains available inside the tab. Browsers cannot guarantee or force native Safari View Controller appearance or dismiss it themselves. This is a web app, not a native iOS app.
- iOS handles links outside the web-app manifest scope through its system external-link flow. On supported iOS versions, this is Safari View Controller with a Done button. YouTube might also redirect to the installed YouTube app depending on iOS settings and universal links.

## iOS 27 top-of-screen blur fix

- Removed `apple-mobile-web-app-status-bar-style=black-translucent`, which can trigger Apple's translucent gradient/scrim in iOS 27 Home Screen web apps.
- Kept the dark `theme-color` and manifest colors so the system status area can match Secure Browser's theme.
- This relies on iOS/WebKit rendering; the web app cannot disable every OS-level blur effect.
- **Important:** Deploy updated project, then **remove the old Home Screen icon and use Safari → Share → Add to Home Screen** to reinstall so iOS picks up updated startup metadata.


## Tab bar update

- New tab (+) is inside the horizontally scrolling tab rail immediately after the newest/rightmost tab, not pinned to the far right of the screen.
- Opening a tab animates it into place; the rail pans to reveal the + button.
- Switching tabs has a subtle active-state transition and animated accent underline.
- Closing a tab collapses smoothly while selecting the next page immediately.
- Respects the iOS Reduce Motion accessibility preference.
- No changes to proxy, Safari fallback, Secure Search, Input Summary, or iOS status-bar settings.

## iOS 27 top-blur mitigation (November 2026)

A persistent blurry strip in **installed iOS 27 PWAs** is an iOS/WebKit rendering effect, not a CSS blur in the browser. Removing the old status-bar meta tag alone does not reliably fix it.

This release preserves the animated tabs and adds an always-opaque 10px fixed strip at the physical top of the display **only for Apple Home Screen app mode**. Testing reported in September 2026 found a fixed strip at least 6px tall, 80% viewport wide and within 4px of the top could replace the system's large blur with a solid top area. The strip stays out of the way of taps and does not move when changing tabs. It adopts the browser's `--bg` theme color.

This is an **experimental iOS-specific workaround, not a guaranteed fix** for every iOS 27 build. If it does not work, enable **Settings > Accessibility > Display & Text Size > Reduce Transparency** on the iPhone; this makes the system blur mostly solid but changes transparency systemwide.

Original source for workaround: https://modernwebweekly.substack.com/p/so-whats-up-with-the-ios27-blur

Deploy the complete Netlify project, close and relaunch the Home Screen app. If an old version persists, reinstall its Home Screen icon after deployment.

## Input Summary — Questions & Answers

- You can type natural questions (e.g. **Why is the sky blue?**, **What is the capital of France?**, **When was the first iPhone released?**) in Secure Browser's address bar or on the Secure Search homepage.
- **Input Summary** now attempts to display one direct, source-linked answer sentence above the regular web results. It can answer questions about definitions, people, places, dates, numbers, reasons, and processes where source text supports the answer.
- It uses keyword relevance, answer-pattern checks, and excerpts from accessible pages or search descriptions. **It is not an AI model**, does not invent sentences, and does not promise an answer to every query.
- The answer is explicitly labeled as either a **web page** excerpt or a **search description**. Supporting extracts and original source links appear below; questions with insufficient evidence clearly report that no verified direct answer was available.
- Input Summary runs **concurrently with web search results** rather than delaying the result list. On deployment it requires the `/api/summary` Netlify function included in this project.
- This is a lightweight, non-AI extraction service; it cannot reliably resolve ambiguous questions, perform multi-step inference, check breaking news, or guarantee that upstream source content is accurate.

To run the non-network question-answering tests with Node.js: `npm test`.

## Input Summary — Cause-first answers (new)

- “Why…” and “What causes…” questions now scan the **body text** of accessible source pages for explanations, then display the causal reason first. This no longer treats a blog/search preview or a page meta-description as a verified explanation.
- A separate related explanation may appear beneath the answer. Each statement links to the corresponding source; when a second domain supports the explanation, it is linked too.
- The answer generator is deterministic, **not AI**. It cannot reliably explain every topic or synthesize conflicting or complex evidence. It says that it could not verify a cause if no suitable explanation was found.
- Up to six websites are checked concurrently for why-questions (versus three for other queries). Website fetching remains bounded by short timeouts.
- The normal search results remain available even if none of the webpages can be read.

## Secure Search: Liquid Glass + All / Images / Videos / Maps (latest)

- **Same Secure Browser:** This update starts from the Apple animated-tabs, Safari-fallback, iOS top-blur mitigation, and source-backed Input Summary build. It does not replace the browser's tab bar or browser tools.
- **Liquid-glass search pages:** Secure Search now uses the bundled Secure Browser beach-sunset start wallpaper, translucent glass panels, softened borders, and responsive layouts. When the start-page background is a custom image, the search page tries to inherit it from the parent browser. Custom *video* backgrounds are not reproduced in Secure Search.
- **Search categories:** Search-result pages have **All**, **Images**, **Videos**, and **Maps** tabs. They update within the existing browser tab and preserve the query. The normal browser's plus-tab and animations are unchanged.
- **All:** Full web links and Input Summary for questions. The search service now returns results after a short response window instead of waiting for the slowest provider, and fills its in-memory cache from late responses where possible. The page fetches local quick matches and live results concurrently, and uses session cache for repeated recent searches.
- **Images:** Image and thumbnail discovery from the public Wikimedia Commons API; each image links to its source file page. Availability depends on the Commons API.
- **Videos:** Uses this project's existing YouTube discovery endpoint (the official YouTube Data API if `YOUTUBE_API_KEY` is provided, otherwise limited public search). YouTube video links continue to open in Safari automatically from the Apple Home Screen web app, when user interaction allows it.
- **Maps:** Searches OpenStreetMap-backed places through the Photon geocoder, with an OpenStreetMap preview and original map links. Results and preview tiles require an internet connection. © OpenStreetMap contributors.
- **Faster link choices:** The standard result title still uses Secure Browser's tab navigation. Results also contain **Open directly ↗** to bypass the potentially slow or incompatible iframe proxy for a particular website. Faster search-result delivery **does not fix** websites whose CSS or scripts do not function through the proxy.
- **Service failures:** Each category provides an external-source link when the upstream service is unavailable. The project does not invent images/videos/map results.

### Deploying the update

Deploy the **entire** project using Netlify's Git integration or Netlify CLI (not just `public/index.html`). The new `/api/media` function and `/api/media` redirect must be deployed alongside the existing search, summary, and proxy functions. Reopen the iOS Home Screen app to load the update; if it stays cached, remove the Home Screen shortcut and add it again.

### Tests

`npm test` runs the existing Input Summary tests and a new offline unit test for image/place discovery and cache behavior. The Secure Search results and category layouts were also checked with mocked data in Chromium at desktop and mobile widths. Live Netlify deployment, remote search provider uptime, and actual website rendering were not tested here.


## Icons, Input Summary animation, and visual themes

- Secure Search uses the first supplied blue magnifying-glass shield icon; Input Summary uses the second blue star icon. Both are locally stored WebP assets.
- Input Summary displays an animated orbital star, progress shimmer, and stage text while `/api/summary` is pending. Animations respect reduced-motion settings and stop on success or failure.
- Open **Customize → Start page & Secure Search style** and select **Glass**, **Solid**, or **Frutiger Aero**. The choice persists locally and applies to the start page and Secure Search results pages, including All, Images, Videos, and Maps. Your wallpaper is retained.
- The normal browser toolbar is unchanged.
- To deploy, use a Git-linked Netlify site or Netlify CLI so server-side functions are deployed.


## Input Summary content gate

Input Summary is hidden (including its loading animation) for queries matching clearly explicit adult content, graphic gore, certain abusive terms, or dangerous how-to requests. The **ordinary search results remain available**. Educational and prevention questions are not automatically treated as explicit. The same query guard runs in the browser and in `/api/summary`, so blocked queries do not trigger the summarization backend. This is a keyword/phrase heuristic, not a complete content moderation classifier; some inappropriate queries can evade it and some ambiguous queries can be classified incorrectly.
