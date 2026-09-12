(() => {
  if (window.__grokLibraryDownloaderLoaded) return;
  window.__grokLibraryDownloaderLoaded = true;

  const state = {
    running: false,
    stopping: false,
    phase: "idle",
    found: 0,
    downloaded: 0,
    deleted: 0,
    operation: "download",
    confirmation: null,
    failed: 0,
    message: "대기 중"
  };

  const media = new Map();
  let pendingConfirmation = null;
  let confirmationSequence = 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function report(patch) {
    Object.assign(state, patch);
    chrome.runtime.sendMessage({ type: "GROK_DOWNLOAD_PROGRESS", state: { ...state } }).catch(() => {});
  }

  function showDeletionToast() {
    document.getElementById("grok-deletion-toast")?.remove();
    const host = document.createElement("div");
    host.id = "grok-deletion-toast";
    host.style.cssText = "all:initial;position:fixed;right:16px;bottom:16px;width:min(380px,calc(100vw - 32px));z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      .toast { box-sizing: border-box; padding: 16px; border: 1px solid #777; border-radius: 8px;
        color: #f4f4f4; background: #242424; box-shadow: 0 4px 20px #0005;
        font: 14px/1.5 "Noto Sans KR", sans-serif; overflow-wrap: anywhere; }
      .toast.error { border-color: #ef8989; }
      .heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      strong { font-size: 14px; }
      p { margin: 8px 0 0; white-space: pre-wrap; max-height: 30vh; overflow-y: auto; }
      button { flex-shrink: 0; padding: 4px 8px; border: 1px solid #888; border-radius: 4px;
        background: transparent; color: inherit; font: inherit; cursor: pointer; }
      button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    `;
    const toast = document.createElement("section");
    toast.className = state.phase === "error" ? "toast error" : "toast";
    toast.setAttribute("role", state.phase === "error" ? "alert" : "status");
    toast.setAttribute("aria-atomic", "true");
    const heading = document.createElement("div");
    heading.className = "heading";
    const title = document.createElement("strong");
    title.textContent = state.phase === "done" ? "Grok 삭제 완료"
      : state.phase === "cancelled" ? "Grok 삭제 취소" : "Grok 삭제 중단";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "닫기";
    close.setAttribute("aria-label", "삭제 결과 알림 닫기");
    const message = document.createElement("p");
    message.textContent = state.message;
    heading.append(title, close);
    toast.append(heading, message);
    root.append(style, toast);
    (document.body || document.documentElement).append(host);
    const timer = setTimeout(() => host.remove(), 12000);
    close.addEventListener("click", () => {
      clearTimeout(timer);
      host.remove();
    });
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
    report({ running: true, stopping: false, operation: "download", phase: "scanning", found: 0, downloaded: 0, deleted: 0, failed: 0, message: "목록 탐색 시작" });

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

  function libraryItems() {
    return [...document.querySelectorAll("button[data-library-item-id]")]
      .filter((button) => button.getClientRects().length)
      .map((button) => {
        const card = button.parentElement;
        const row = button.closest("[data-index]");
        return {
          id: button.dataset.libraryItemId,
          button,
          card,
          row: row ? Number(row.dataset.index) : NaN,
          type: card.querySelector("video") ? "video" : card.querySelector("img") ? "image" : null
        };
      }).sort((first, second) => first.row - second.row);
  }

  function libraryScroller(item) {
    for (let element = item.button.parentElement; element; element = element.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(element).overflowY)) return element;
    }
    return document.scrollingElement;
  }

  function moveLibrary(scroller, top) {
    if (scroller === document.scrollingElement) window.scrollTo({ top, behavior: "instant" });
    else scroller.scrollTo({ top, behavior: "instant" });
  }

  function checkDeletion() {
    if (state.stopping) throw new Error("삭제 중지 요청");
    if (location.pathname !== "/library" && location.pathname !== "/library/") {
      throw new Error("라이브러리 페이지가 변경되어 중단합니다");
    }
  }

  async function scanDeletion(options) {
    const initial = libraryItems();
    if (!initial.length) throw new Error("삭제 가능한 라이브러리 항목을 찾지 못했습니다");
    const scroller = libraryScroller(initial[0]);
    const items = new Map();
    const rows = new Set();
    let previous = "";
    let stable = 0;
    let stalled = 0;
    moveLibrary(scroller, 0);
    await sleep(900);
    const firstRow = libraryItems()[0]?.row;
    if (!Number.isInteger(firstRow) || firstRow < 0) {
      throw new Error("목록 시작 행을 확인할 수 없습니다");
    }
    while (stable < 6) {
      checkDeletion();
      if (!scroller.isConnected) throw new Error("라이브러리 목록이 변경되었습니다");
      const visible = libraryItems();
      for (const item of visible) {
        if (!Number.isInteger(item.row) || !scroller.contains(item.button)) {
          throw new Error("라이브러리 정렬 구조를 확인할 수 없습니다");
        }
        rows.add(item.row);
        if (items.has(item.id) && items.get(item.id).row !== item.row) {
          throw new Error("탐색 중 목록 순서가 변경되었습니다");
        }
        if (item.type && options[item.type] && !items.has(item.id)) {
          items.set(item.id, { id: item.id, row: item.row });
        }
      }
      const top = scrollPosition(scroller);
      const atBottom = top + scroller.clientHeight >= scroller.scrollHeight - 2;
      const signature = `${scroller.scrollHeight}:${top}:${visible.map((item) => item.id).join(",")}`;
      stable = atBottom && signature === previous ? stable + 1 : 0;
      stalled = !atBottom && signature === previous ? stalled + 1 : 0;
      if (stalled >= 6) throw new Error("목록 끝에 도달하기 전에 스크롤이 멈췄습니다");
      previous = signature;
      report({ found: items.size, message: atBottom
        ? `목록 끝 확인 중 (${stable}/6): ${items.size}개`
        : `삭제 대상 탐색 중: ${items.size}개` });
      if (!atBottom) moveLibrary(scroller, top + Math.max(1, scroller.clientHeight * 0.7));
      await sleep(900);
    }
    const orderedItems = [...items.values()].sort((first, second) => first.row - second.row).reverse();
    const partial = options.count !== null && options.count < orderedItems.length;
    const requiredFirstRow = partial ? orderedItems[options.count - 1].row : firstRow;
    const sortedRows = [...rows].filter((row) => row >= requiredFirstRow).sort((first, second) => first - second);
    const missingIndex = sortedRows.findIndex((row, index) => row !== requiredFirstRow + index);
    if (!sortedRows.length || missingIndex !== -1) {
      const expectedRow = requiredFirstRow + Math.max(0, missingIndex);
      throw new Error(`일부 목록 행을 읽지 못했습니다 (검사 시작 행 ${requiredFirstRow}, 확인 필요 행 ${expectedRow}). 삭제하지 않고 중단합니다`);
    }
    return { scroller, items: orderedItems };
  }

  async function waitDeletion(read, errorMessage) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      checkDeletion();
      const result = read();
      if (result) return result;
      await sleep(100);
    }
    throw new Error(typeof errorMessage === "function" ? errorMessage() : errorMessage);
  }

  function visibleElements(selector, root = document) {
    return [...root.querySelectorAll(selector)].filter((element) => element.getClientRects().length);
  }

  function deleteControl(root, selector) {
    const matches = visibleElements(selector, root).filter((element) =>
      /^(삭제|삭제하기|영구 삭제|delete|delete permanently)$/i.test(element.textContent.trim()) &&
      !element.disabled && element.getAttribute("aria-disabled") !== "true"
    );
    return matches.length === 1 ? matches[0] : null;
  }

  async function locateDeletionItem(scroller, id) {
    while (true) {
      checkDeletion();
      const item = libraryItems().find((candidate) => candidate.id === id);
      if (item) return item;
      const top = scrollPosition(scroller);
      if (top <= 0) throw new Error("예정된 삭제 항목을 찾지 못했습니다. 목록 변경 여부를 확인해 주세요");
      moveLibrary(scroller, Math.max(0, top - scroller.clientHeight * 0.7));
      await sleep(900);
      if (scrollPosition(scroller) === top) throw new Error("삭제 항목 탐색 중 스크롤이 멈췄습니다");
    }
  }

  async function deleteLibraryItem(item, scroller, allowScrollRecovery = false) {
    if (visibleElements('[role="dialog"], [role="alertdialog"], [role="menu"]').length) {
      throw new Error("열려 있는 메뉴나 대화상자를 닫은 후 다시 실행해 주세요");
    }
    const trigger = item.card.querySelector('button[aria-haspopup="menu"]');
    if (!trigger || trigger.disabled) throw new Error("항목 작업 메뉴를 찾지 못했습니다");
    checkDeletion();
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, composed: true, pointerType: "mouse", button: 0, buttons: 1 }));
    trigger.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, composed: true, pointerType: "mouse", button: 0, buttons: 0 }));
    const menu = await waitDeletion(() => {
      if (!trigger.isConnected || !item.button.isConnected) {
        throw new Error("메뉴를 여는 동안 삭제 대상이 변경되었습니다");
      }
      const controls = trigger.getAttribute("aria-controls");
      const matches = visibleElements('[role="menu"]').filter((candidate) => {
        if (candidate.getAttribute("data-state") === "closed") return false;
        const labelledBy = (candidate.getAttribute("aria-labelledby") || "").split(/\s+/);
        return (controls && candidate.id === controls) || (trigger.id && labelledBy.includes(trigger.id));
      });
      return matches.length === 1 ? matches[0] : null;
    }, "이 항목에 연결된 작업 메뉴를 확인할 수 없습니다");
    const action = deleteControl(menu, '[role="menuitem"]');
    if (!action) throw new Error("삭제 메뉴를 찾지 못했습니다. 메뉴 HTML 확인이 필요합니다");
    checkDeletion();
    const beforeTop = scrollPosition(scroller);
    const beforeHeight = scroller.scrollHeight;
    const beforeItems = libraryItems();
    const predecessor = beforeItems.at(-2);
    const canRecoverLastItem = allowScrollRecovery &&
      beforeTop + scroller.clientHeight >= beforeHeight - 2 &&
      beforeItems.at(-1)?.id === item.id && predecessor && predecessor.row <= item.row;
    let recoveringLastRow = false;
    let recoveryAttempts = 0;
    const resultError = (reason) => {
      const currentItems = libraryItems();
      const last = currentItems.at(-1);
      const currentTop = scrollPosition(scroller);
      const height = scroller.scrollHeight;
      const expectedTop = Math.min(beforeTop, Math.max(0, height - scroller.clientHeight));
      const dialogs = visibleElements('[role="dialog"], [role="alertdialog"]');
      const targetPresent = currentItems.some((candidate) => candidate.id === item.id);
      return `${reason}\n[삭제 진단] 대상=${item.id}, 행=${item.row}, 대상 DOM=${targetPresent ? "있음" : "없음"}, ` +
        `목록 연결=${scroller.isConnected}, 확인창=${dialogs.length}, 확인 클릭=${confirmed}, ` +
        `메뉴=${visibleElements('[role="menu"]').length}, 복구 가능=${Boolean(canRecoverLastItem)}, 복구=${recoveryAttempts}/3\n` +
        `스크롤=${Math.round(beforeTop)}→${Math.round(currentTop)}, 예상=${Math.round(expectedTop)}, ` +
        `높이=${beforeHeight}→${height}, 화면 높이=${scroller.clientHeight}, ` +
        `마지막=${last?.id || "없음"}(행 ${last?.row ?? "없음"}), 이전 이웃=${predecessor?.id || "없음"}(행 ${predecessor?.row ?? "없음"})`;
    };
    const layoutSettled = () => {
      const expectedTop = Math.min(beforeTop, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
      return scroller.isConnected && Math.abs(scrollPosition(scroller) - expectedTop) <= 2 &&
        scroller.scrollHeight <= beforeHeight;
    };
    const deletionVisible = () => {
      const currentItems = libraryItems();
      if (!scroller.isConnected || currentItems.some((candidate) => candidate.id === item.id)) return false;
      if (!recoveringLastRow) return layoutSettled();
      const last = currentItems.at(-1);
      return scrollPosition(scroller) + scroller.clientHeight >= scroller.scrollHeight - 2 &&
        last?.id === predecessor.id && last.row === predecessor.row;
    };
      const recoverLastRow = () => {
        if (!canRecoverLastItem || !scroller.isConnected || recoveryAttempts >= 3 ||
          libraryItems().some((candidate) => candidate.id === item.id)) return false;
        checkDeletion();
        recoveryAttempts += 1;
        recoveringLastRow = true;
        report({ message: `마지막 항목 삭제 결과 확인 중: 목록 끝 재확인 (${recoveryAttempts}/3)` });
        moveLibrary(scroller, scroller.scrollHeight);
        return true;
      };
    action.click();
    let confirmed = false;
    await waitDeletion(() => {
      const dialogs = visibleElements('[role="dialog"], [role="alertdialog"]');
      if (dialogs.length) {
        if (confirmed) return false;
        if (dialogs.length !== 1) throw new Error("삭제 확인창을 특정할 수 없습니다");
        const confirmButton = deleteControl(dialogs[0], "button");
        if (!confirmButton) return false;
        confirmed = true;
        confirmButton.click();
        return false;
      }
      if (!deletionVisible() && !layoutSettled() && recoverLastRow()) return false;
      return deletionVisible();
    }, () => resultError("목록 재배치 또는 삭제 결과를 확인하지 못했습니다. 해당 항목은 이미 삭제됐을 수 있으므로 페이지에서 확인해 주세요"));
    while (true) {
      await sleep(900);
      checkDeletion();
      if (libraryItems().some((candidate) => candidate.id === item.id)) {
        throw new Error(resultError("삭제 항목이 다시 나타났습니다. 서버 처리 결과를 확인해 주세요"));
      }
      if (deletionVisible()) return;
      if (!recoverLastRow()) {
        throw new Error(resultError("삭제 결과 확인 중 목록 위치 또는 마지막 항목이 변경되었습니다. 해당 항목은 이미 삭제됐을 수 있으므로 페이지에서 확인해 주세요"));
      }
      await waitDeletion(deletionVisible, () => resultError("목록 끝 재확인 후 삭제 결과를 확인하지 못했습니다. 해당 항목을 페이지에서 확인해 주세요"));
    }
  }

  function previewDeletion(options) {
    checkDeletion();
    const visible = libraryItems();
    if (!visible.length) throw new Error("현재 화면에서 삭제할 항목을 찾지 못했습니다");
    const scroller = libraryScroller(visible[0]);
    const items = visible.filter((item) => item.type && options[item.type]);
    if (options.currentPosition) items.reverse();
    if (items.length < options.count) {
      throw new Error(`현재 읽을 수 있는 대상은 ${items.length}개입니다. 삭제 개수를 줄여 주세요`);
    }
    return { scroller, position: scrollPosition(scroller), items: items.slice(0, options.count).map((item) => ({
      id: item.id, row: item.row, name: item.button.getAttribute("aria-label") || item.id
    })) };
  }

  function confirmDeletion(text) {
    return new Promise((resolve) => {
      const id = `${Date.now()}:${++confirmationSequence}`;
      pendingConfirmation = { id, resolve };
      report({ phase: "confirming", confirmation: { id, text }, message: "확장 팝업에서 삭제 실행 또는 취소를 선택해 주세요" });
    });
  }

  function resolveDeletionConfirmation(confirmed) {
    const pending = pendingConfirmation;
    pendingConfirmation = null;
    report({ confirmation: null });
    pending?.resolve(confirmed);
  }

  async function runDeletion(options) {
    if (state.running) return;
    report({ running: true, stopping: false, operation: "delete", phase: "scanning", found: 0, downloaded: 0, deleted: 0, failed: 0, message: "삭제 대상 탐색 시작" });
    try {
      const local = options.testMode || options.currentPosition;
      const { scroller, items, position } = local ? previewDeletion(options) : await scanDeletion(options);
      let testPosition = position;
      checkDeletion();
      const targets = options.count === null ? items : items.slice(0, options.count);
      report({ found: targets.length });
      const all = !local && targets.length === items.length;
      const scope = options.testMode
        ? `[테스트 삭제] 현재 읽힌 목록 앞쪽 미디어 ${targets.length}개\n${targets.map((item) => item.name).join("\n")}`
        : all ? `선택한 미디어 유형 전체 ${targets.length}개` : `가장 오래된 미디어 ${targets.length}개`;
      if (!targets.length || ((all || options.testMode) && !await confirmDeletion(`${scope}를 삭제하시겠습니까?\n삭제는 되돌릴 수 없습니다.${all ? "\n전체 삭제를 실행합니다." : ""}`))) {
        checkDeletion();
        report({ phase: "cancelled", message: targets.length ? "삭제를 취소했습니다" : "삭제할 미디어가 없습니다" });
        return;
      }
      checkDeletion();
      report({ phase: "deleting", message: `${targets.length}개 삭제 시작` });
      for (const target of targets) {
        checkDeletion();
        const item = local
          ? libraryItems().find((candidate) => candidate.id === target.id)
          : await locateDeletionItem(scroller, target.id);
        if (!item) throw new Error("삭제 대상이 화면에서 사라졌습니다. 자동 탐색 없이 중단합니다");
        if (local && (!scroller.isConnected || Math.abs(scrollPosition(scroller) - testPosition) > 2)) {
          throw new Error("삭제 중 목록 위치가 변경되었습니다");
        }
        if (!options.testMode && item.row !== target.row) throw new Error("삭제 대상의 목록 순서가 변경되어 중단합니다");
        await deleteLibraryItem(item, scroller, !options.testMode);
        if (local) testPosition = scrollPosition(scroller);
        state.deleted += 1;
        report({ message: `삭제 완료 ${state.deleted}/${targets.length}개` });
      }
      report({ phase: "done", message: `완료: ${state.deleted}개 삭제` });
    } catch (error) {
      report({
        phase: state.stopping ? "stopped" : "error",
        failed: state.phase === "deleting" && !state.stopping ? 1 : 0,
        message: state.stopping ? `중지됨: ${state.deleted}개 삭제 확인, 진행 중 항목은 페이지에서 확인해 주세요` : `${state.deleted}개 삭제 확인 후 중단: ${error.message}`
      });
    } finally {
      report({ running: false, stopping: false });
      showDeletionToast();
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
    if (message.type === "START_GROK_DELETE") {
      const options = message.options;
      if (state.running || !options || (!options.image && !options.video) ||
          ((options.testMode || options.currentPosition) && options.count === null) ||
          (options.testMode && options.currentPosition) ||
          (options.count !== null && (!Number.isSafeInteger(options.count) || options.count < 1))) {
        sendResponse({ ok: false, error: "작업 상태 또는 삭제 개수를 확인해 주세요" });
        return false;
      }
      runDeletion(options);
      sendResponse({ ok: true, state: { ...state } });
      return false;
    }
    if (message.type === "CONFIRM_GROK_DELETE") {
      if (!pendingConfirmation || pendingConfirmation.id !== message.id || typeof message.confirmed !== "boolean") {
        sendResponse({ ok: false, error: "삭제 확인 요청이 만료되었습니다. 팝업을 다시 열어 주세요" });
        return false;
      }
      resolveDeletionConfirmation(message.confirmed);
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "STOP_GROK_DOWNLOAD") {
      state.stopping = true;
      if (pendingConfirmation) resolveDeletionConfirmation(false);
      report({ message: "현재 단계가 끝나면 중지합니다" });
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();
