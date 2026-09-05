(() => {
  if (window.__grokLibraryDownloaderLoaded) return;
  window.__grokLibraryDownloaderLoaded = true;

  const state = {
    running: false,
    stopping: false,
    phase: "idle",
    found: 0,
    downloaded: 0,
    failed: 0,
    message: "대기 중"
  };

  const media = new Map();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function report(patch) {
    Object.assign(state, patch);
    chrome.runtime.sendMessage({ type: "GROK_DOWNLOAD_PROGRESS", state: { ...state } }).catch(() => {});
  }

  function absoluteUrl(value) {
    if (!value || value.startsWith("blob:") || value.startsWith("data:")) return null;
    try {
      const url = new URL(value, location.href);
      return url.protocol === "https:" ? url.href : null;
    } catch {
      return null;
    }
  }

  function looksLikeMedia(url, typeHint = "") {
    if (!url) return false;
    if (typeHint === "image" || typeHint === "video") return true;
    return /\.(?:avif|gif|jpe?g|png|webp|mp4|mov|m4v|webm)(?:$|[?#])/i.test(url);
  }

  function inferType(url, hint = "") {
    if (hint) return hint;
    return /\.(?:mp4|mov|m4v|webm)(?:$|[?#])/i.test(url) ? "video" : "image";
  }

  function addMedia(value, hint = "", element = null) {
    const url = absoluteUrl(value);
    if (!looksLikeMedia(url, hint)) return;
    if (/\.(?:png|svg|webp)$/i.test(new URL(url).pathname)) return;
    if (hint === "image" && element && element.naturalWidth < 200 && element.naturalHeight < 200) return;
    const type = inferType(url, hint);
    const existing = media.get(url);
    media.set(url, existing || { url, type });
  }

  function collectFromPage() {
    document.querySelectorAll("img").forEach((element) => {
      addMedia(element.currentSrc || element.src, "image", element);
      if (element.srcset) {
        const candidates = element.srcset.split(",");
        addMedia(candidates.at(-1)?.trim().split(/\s+/)[0], "image", element);
      }
    });

    document.querySelectorAll("video").forEach((element) => {
      addMedia(element.currentSrc || element.src, "video");
      element.querySelectorAll("source").forEach((source) => addMedia(source.src, "video"));
    });

    document.querySelectorAll("a[href]").forEach((element) => addMedia(element.href));

    performance.getEntriesByType("resource")
      .filter((entry) => entry.initiatorType === "video")
      .forEach((entry) => addMedia(entry.name, "video"));
    state.found = media.size;
  }

  function findMainScroller() {
    const candidates = [document.scrollingElement, ...document.querySelectorAll("main, [role='main'], div")];
    return [...new Set(candidates)].filter((element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      return element.scrollHeight > element.clientHeight + 100 &&
        (element === document.scrollingElement || /(auto|scroll)/.test(style.overflowY));
    }).sort((a, b) => (b.clientHeight * (b.scrollHeight - b.clientHeight)) - (a.clientHeight * (a.scrollHeight - a.clientHeight)))[0]
      || document.scrollingElement;
  }

  function scrollPosition(element) {
    return element === document.scrollingElement ? window.scrollY : element.scrollTop;
  }

  function scrollForward(element) {
    const top = scrollPosition(element) + Math.max(400, element.clientHeight * 0.8);
    if (element === document.scrollingElement) {
      window.scrollTo({ top, behavior: "instant" });
    } else {
      element.scrollTo({ top, behavior: "instant" });
    }
  }

  async function scan(options) {
    media.clear();
    let unchangedRounds = 0;
    let lastSignature = "";
    let scrollCount = 0;

    collectFromPage();

    while (
      !state.stopping &&
      unchangedRounds < 6 &&
      (options.maxScrolls === null || scrollCount < options.maxScrolls)
    ) {
      collectFromPage();
      const scroller = findMainScroller();
      scrollForward(scroller);
      scrollCount += 1;
      await sleep(900);
      collectFromPage();

      const signature = `${scroller.scrollHeight}:${Math.round(scrollPosition(scroller))}:${media.size}`;
      unchangedRounds = signature === lastSignature ? unchangedRounds + 1 : 0;
      lastSignature = signature;
      const limit = options.maxScrolls === null ? "전체" : options.maxScrolls;
      report({ found: media.size, message: `목록 탐색 중 (${scrollCount}/${limit}회 스크롤)` });
    }

    return [...media.values()].filter((item) => options[item.type]);
  }

  function originalFilename(item) {
    try {
      const pathname = decodeURIComponent(new URL(item.url).pathname);
      const basename = pathname.split("/").filter(Boolean).at(-1) || item.type;
      const match = basename.match(/^(.*)\.([a-z0-9]{2,5})$/i);
      const validExtension = match && /^(avif|gif|jpe?g|png|webp|mp4|mov|m4v|webm)$/i.test(match[2]);
      const stem = (validExtension ? match[1] : basename)
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .replace(/[. ]+$/g, "") || item.type;
      const extension = validExtension ? match[2].toLowerCase() : item.type === "video" ? "mp4" : "jpg";
      return { stem, extension };
    } catch {}
    return { stem: item.type, extension: item.type === "video" ? "mp4" : "jpg" };
  }

  function directoryStamp(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return (
      pad(date.getFullYear() % 100) +
      pad(date.getMonth() + 1) +
      pad(date.getDate()) +
      "_" +
      pad(date.getHours()) +
      pad(date.getMinutes()) +
      pad(date.getSeconds())
    );
  }

  function download(item, directoryTimestamp) {
    const { stem, extension } = originalFilename(item);
    const filename = `Grok Library_${directoryTimestamp}/${stem}_${Date.now()}.${extension}`;
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "DOWNLOAD_MEDIA", url: item.url, filename },
        (response) => resolve(response || { ok: false, error: chrome.runtime.lastError?.message })
      );
    });
  }

  async function run(options) {
    if (state.running) return;
    report({ running: true, stopping: false, phase: "scanning", found: 0, downloaded: 0, failed: 0, message: "목록 탐색 시작" });

    try {
      const items = await scan(options);
      const directoryTimestamp = directoryStamp(new Date());
      report({ phase: "downloading", found: items.length, message: `${items.length}개 다운로드 시작` });

      for (let index = 0; index < items.length && !state.stopping; index += 1) {
        const result = await download(items[index], directoryTimestamp);
        if (result.ok) state.downloaded += 1;
        else state.failed += 1;
        report({ message: `다운로드 요청 ${index + 1}/${items.length}` });
        await sleep(200);
      }

      report({
        phase: "done",
        message: state.stopping
          ? `중지됨: ${state.downloaded}개 요청 완료`
          : `완료: ${state.downloaded}개 요청, ${state.failed}개 실패`
      });
    } catch (error) {
      report({ phase: "error", message: `오류: ${error.message}` });
    } finally {
      report({ running: false, stopping: false });
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "GET_GROK_DOWNLOAD_STATE") {
      sendResponse({ ...state });
      return false;
    }
    if (message.type === "START_GROK_DOWNLOAD") {
      run(message.options);
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "STOP_GROK_DOWNLOAD") {
      state.stopping = true;
      report({ message: "현재 단계가 끝나면 중지합니다" });
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();
