const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");

const source = readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

function library({ size = 20, confirm = true, menuLabel = "삭제", dialog = true, remove = true, onDialog, lateItem = false, skipRow = -1, reorder = false, columns = 1, labelledMenu = false, deferredMenu = false, initialTop = 700, autoConfirm = true, rowOffset = 0, delayedLayout = false, scrollWithoutDelete = false, anchorAfterRowRemoval = false, phantomLastRow = false, stopDuringRecovery = false, lateAnchorAt = 0, lateAnchorRepeats = 1, anchorAfterItemRemoval = false, resultDelayRounds = 0, stopDuringResultWait = false, ignoreFirstDelete = false, onRetryMenu, keepDialog = false, onResultWait } = {}) {
  const dom = new JSDOM('<div id="library" style="overflow-y: auto"></div>', {
    url: "https://grok.com/library",
    runScripts: "outside-only"
  });
  const { window } = dom;
  const scroller = window.document.querySelector("#library");
  const items = Array.from({ length: size }, (_, index) => ({ id: `media-${index}`, type: index % 2 ? "video" : "image" }));
  const deleted = [];
  const deleteRequests = [];
  let pendingDelete = null;
  let remainingDeleteRounds = 0;
  const confirmations = [];
  const confirmationAcknowledgements = [];
  let startAcknowledged = false;
  let listener;
  let finish;
  let latest;
  let injected = false;
  let pendingLateItem = false;
  let pendingLayout = 0;
  let layoutHeight = null;
  let lateAnchors = 0;
  const toastTimers = [];
  let done = new Promise((resolve) => { finish = resolve; });
  window.HTMLElement.prototype.getClientRects = function () {
    return this.isConnected && !this.hidden ? [{}] : [];
  };
  window.PointerEvent = window.MouseEvent;
  window.setTimeout = (callback, delay) => {
    if (delay === 12000) {
      toastTimers.push(callback);
      return toastTimers.length;
    }
    queueMicrotask(() => {
      if (delay === 100 && pendingDelete && --remainingDeleteRounds <= 0) {
        const apply = pendingDelete;
        pendingDelete = null;
        apply();
      }
      if (delay === 900 && lateAnchorAt > 0 && deleted.length === lateAnchorAt && lateAnchors < lateAnchorRepeats) {
        lateAnchors += 1;
        scroller.scrollTo({ top: scroller.scrollTop - 80 });
      }
      if (pendingLayout > 0 && --pendingLayout === 0) {
        layoutHeight = null;
        scroller.scrollTo({ top: scroller.scrollTop });
      }
      if (pendingLateItem) {
        pendingLateItem = false;
        items.push({ id: "media-late", type: "image" });
        render();
      }
      callback();
    });
  };
  window.confirm = () => { throw new Error("네이티브 확인창을 호출하면 안 됩니다"); };
  const answerConfirmation = (message) => {
    confirmations.push(message);
    confirmationAcknowledgements.push(startAcknowledged);
    if (reorder) {
      items.unshift({ id: "new-media", type: "image" });
      render();
    }
    return confirm;
  };
  window.chrome = {
    runtime: {
      onMessage: { addListener(callback) { listener = callback; } },
      sendMessage(message) {
        latest = message.state;
        if (onResultWait && latest.running && latest.message.includes("삭제 반영 확인 대기 중")) {
          const callback = onResultWait;
          onResultWait = null;
          callback({ window, scroller });
        }
        if (stopDuringResultWait && latest.message.includes("삭제 반영 확인 대기 중")) {
          queueMicrotask(() => listener({ type: "STOP_GROK_DOWNLOAD" }, {}, () => {}));
        }
        if (stopDuringRecovery && latest.message.includes("목록 끝 재확인")) {
          queueMicrotask(() => listener({ type: "STOP_GROK_DOWNLOAD" }, {}, () => {}));
        }
        if (autoConfirm && latest.confirmation) {
          const confirmation = latest.confirmation;
          queueMicrotask(() => listener({ type: "CONFIRM_GROK_DELETE", id: confirmation.id, confirmed: answerConfirmation(confirmation.text) }, {}, () => {}));
        }
        if (lateItem && !injected && latest.phase === "scanning" && scroller.scrollTop === size * 100 - 200) {
          injected = true;
          pendingLateItem = true;
        }
        if (!latest.running) finish(latest);
        return Promise.resolve();
      }
    }
  };
  Object.defineProperties(scroller, {
    clientHeight: { get: () => 200 },
    scrollHeight: { get: () => layoutHeight ?? Math.ceil(items.length / columns) * 100 }
  });
  scroller.scrollTo = ({ top }) => {
    scroller.scrollTop = Math.max(0, Math.min(top, scroller.scrollHeight - scroller.clientHeight));
    render();
  };

  function render() {
    scroller.replaceChildren();
    const first = Math.max(0, Math.floor(scroller.scrollTop / 100) - 1) * columns;
    items.slice(first, first + 5 * columns).forEach((item, offset) => {
      const rowIndex = Math.floor((first + offset) / columns);
      if (rowIndex === skipRow) return;
      const row = window.document.createElement("div");
      row.dataset.index = rowIndex + rowOffset;
      row.innerHTML = `<div><button data-library-item-id="${item.id}"></button><${item.type === "image" ? "img" : "video"} src="https://assets.grok.com/${item.id}/content"></${item.type === "image" ? "img" : "video"}><button aria-haspopup="menu" aria-expanded="false">항목 작업</button></div>`;
      const trigger = row.querySelector('[aria-haspopup="menu"]');
      trigger.id = `actions-${item.id}`;
      let opening = false;
      trigger.addEventListener("click", () => {
        if (deferredMenu) opening = false;
      });
      const openMenu = () => {
        const menu = window.document.createElement("div");
        menu.id = "item-menu";
        menu.setAttribute("role", "menu");
        menu.setAttribute("aria-labelledby", trigger.id);
        menu.setAttribute("data-state", "open");
        menu.innerHTML = `<div role="menuitem"><span><svg aria-hidden="true"></svg></span>다운로드</div><div role="menuitem"><svg aria-hidden="true"></svg>${menuLabel}</div>`;
        if (!labelledMenu) trigger.setAttribute("aria-controls", menu.id);
        trigger.setAttribute("aria-expanded", "true");
        menu.firstChild.addEventListener("click", () => { throw new Error("다운로드 메뉴를 클릭하면 안 됩니다"); });
        menu.lastChild.addEventListener("click", () => {
          menu.remove();
          const apply = () => {
            if (scrollWithoutDelete || (phantomLastRow && items.length % columns === 1)) {
              scroller.scrollTo({ top: 0 });
              return;
            }
            if (!remove) return;
            const oldHeight = scroller.scrollHeight;
            deleted.push(item.id);
            items.splice(items.indexOf(item), 1);
            scroller.scrollTo({ top: scroller.scrollTop });
            if (anchorAfterItemRemoval || (anchorAfterRowRemoval && scroller.scrollHeight < oldHeight)) {
              scroller.scrollTo({ top: scroller.scrollTop - 80 });
            }
            if (delayedLayout && scroller.scrollHeight < oldHeight) {
              layoutHeight = oldHeight;
              pendingLayout = 3;
            }
          };
          const requestDelete = () => {
            deleteRequests.push(item.id);
            if (ignoreFirstDelete && deleteRequests.filter((id) => id === item.id).length === 1) return;
            if (!resultDelayRounds) return apply();
            pendingDelete = apply;
            remainingDeleteRounds = resultDelayRounds;
          };
          if (!dialog) return requestDelete();
          const prompt = window.document.createElement("div");
          prompt.setAttribute("role", "alertdialog");
          prompt.innerHTML = '<button>취소</button><button>삭제</button>';
          prompt.lastChild.addEventListener("click", () => {
            if (!keepDialog) prompt.remove();
            requestDelete();
          });
          window.document.body.append(prompt);
          onDialog?.(() => listener({ type: "STOP_GROK_DOWNLOAD" }, {}, () => {}));
        });
        window.document.body.append(menu);
        if (deleteRequests.includes(item.id)) {
          onRetryMenu?.({ item, scroller, trigger, menu, window, render, stop: () => listener({ type: "STOP_GROK_DOWNLOAD" }, {}, () => {}) });
        }
      };
      trigger.addEventListener("pointerdown", () => {
        opening = true;
        if (deferredMenu) queueMicrotask(() => { if (opening) openMenu(); });
        else openMenu();
      });
      scroller.append(row);
    });
  }

  scroller.scrollTo({ top: initialTop });
  let scrollCalls = 0;
  const originalScrollTo = scroller.scrollTo;
  scroller.scrollTo = (options) => { scrollCalls += 1; originalScrollTo(options); };
  window.eval(source);
  return {
    deleted, deleteRequests, confirmations, confirmationAcknowledgements, items, dom,
    toastTimers,
    scrollCalls: () => scrollCalls,
    start(options = {}) {
      if (latest && !latest.running) done = new Promise((resolve) => { finish = resolve; });
      let response;
      listener({ type: "START_GROK_DELETE", options: { count: null, image: true, video: true, ...options } }, {}, (value) => { response = value; startAcknowledged = true; });
      return response;
    },
    stop() { listener({ type: "STOP_GROK_DOWNLOAD" }, {}, () => {}); },
    confirm(id, confirmed) {
      let response;
      listener({ type: "CONFIRM_GROK_DELETE", id, confirmed }, {}, (value) => { response = value; });
      return response;
    },
    get done() { return done; },
    state: () => latest
  };
}

test("삭제 반영이 8초 지연되어도 한 번만 요청하고 성공 집계", async () => {
  const fixture = library({ resultDelayRounds: 80 });
  fixture.start({ count: 2 });
  const state = await fixture.done;
  assert.equal(state.phase, "done", state.message);
  assert.equal(state.deleted, 2);
  assert.deepEqual(fixture.deleteRequests, ["media-19", "media-18"]);
  assert.deepEqual(fixture.deleted, fixture.deleteRequests);
  fixture.dom.window.close();
});

test("30초 초과 미반영은 같은 ID 재시도 1회 후 다음 항목 삭제 없이 중단", async () => {
  const fixture = library({ remove: false });
  fixture.start({ count: 2 });
  const state = await fixture.done;
  assert.equal(state.phase, "error");
  assert.match(state.message, /삭제 미반영: 최대 30초/);
  assert.equal(state.deleted, 0);
  assert.deepEqual(fixture.deleted, []);
  assert.deepEqual(fixture.deleteRequests, ["media-19", "media-19"]);
  assert.match(state.message, /재시도=1\/1/);
  fixture.dom.window.close();
});

test("첫 요청 미반영 후 같은 ID 재시도로 성공하면 한 번만 집계", async () => {
  for (const options of [{}, { currentPosition: true }, { testMode: true }]) {
    const fixture = library({ ignoreFirstDelete: true, initialTop: 1800 });
    fixture.start({ count: 2, ...options });
    const state = await fixture.done;
    assert.equal(state.phase, "done", state.message);
    assert.equal(state.deleted, 2);
    assert.equal(state.failed, 0);
    assert.equal(new Set(fixture.deleted).size, 2);
    assert.deepEqual(fixture.deleteRequests, fixture.deleted.flatMap((id) => [id, id]));
    fixture.dom.window.close();
  }
});

test("재시도 메뉴를 여는 동안 대상이나 위치가 바뀌거나 중지하면 추가 삭제 없음", async () => {
  for (const change of ["id", "row", "position", "height", "removed", "stop"]) {
    const fixture = library({
      ignoreFirstDelete: true,
      onRetryMenu({ trigger, scroller, stop }) {
        const button = trigger.parentElement.querySelector("[data-library-item-id]");
        if (change === "id") button.dataset.libraryItemId = "different-media";
        if (change === "row") trigger.closest("[data-index]").dataset.index = "999";
        if (change === "position") scroller.scrollTop -= 10;
        if (change === "height") fixture.items.push({ id: "new-media", type: "image" });
        if (change === "removed") button.remove();
        if (change === "stop") stop();
      }
    });
    fixture.start({ count: 2 });
    const state = await fixture.done;
    assert.equal(state.phase, change === "stop" ? "stopped" : "error", change);
    assert.equal(state.deleted, 0);
    assert.deepEqual(fixture.deleteRequests, ["media-19"], change);
    assert.deepEqual(fixture.deleted, [], change);
    fixture.dom.window.close();
  }
});

test("삭제 확인창이 남아 있으면 같은 ID라도 재시도하지 않음", async () => {
  const fixture = library({ remove: false, keepDialog: true });
  fixture.start({ count: 2 });
  assert.equal((await fixture.done).phase, "error");
  assert.deepEqual(fixture.deleteRequests, ["media-19"]);
  assert.deepEqual(fixture.deleted, []);
  fixture.dom.window.close();
});

test("첫 결과 대기 중 목록 또는 메뉴 상태가 바뀌면 재시도하지 않음", async () => {
  for (const change of ["row", "position", "height", "menu", "disconnected"]) {
    const fixture = library({
      remove: false,
      onResultWait({ window, scroller }) {
        const button = scroller.querySelector('[data-library-item-id="media-19"]');
        if (change === "row") button.closest("[data-index]").dataset.index = "999";
        if (change === "position") scroller.scrollTop -= 10;
        if (change === "height") fixture.items.push({ id: "new-media", type: "image" });
        if (change === "disconnected") scroller.remove();
        if (change === "menu") {
          const menu = window.document.createElement("div");
          menu.setAttribute("role", "menu");
          window.document.body.append(menu);
        }
      }
    });
    fixture.start({ count: 2 });
    const state = await fixture.done;
    assert.equal(state.phase, "error", change);
    assert.equal(state.deleted, 0);
    assert.deepEqual(fixture.deleteRequests, ["media-19"], change);
    fixture.dom.window.close();
  }
});

test("재시도 확인창에서 대상이 사라지면 확인 버튼을 누르지 않음", async () => {
  const fixture = library({
    ignoreFirstDelete: true,
    onDialog() {
      if (fixture.deleteRequests.length === 1) {
        fixture.dom.window.document.querySelector('[data-library-item-id="media-19"]').remove();
      }
    }
  });
  fixture.start({ count: 2 });
  assert.equal((await fixture.done).phase, "error");
  assert.deepEqual(fixture.deleteRequests, ["media-19"]);
  assert.deepEqual(fixture.deleted, []);
  fixture.dom.window.close();
});

test("사이트 확인창이 없어도 같은 대상 재시도 후 한 번만 집계", async () => {
  const fixture = library({ ignoreFirstDelete: true, dialog: false });
  fixture.start({ count: 1 });
  assert.equal((await fixture.done).deleted, 1);
  assert.deepEqual(fixture.deleteRequests, ["media-19", "media-19"]);
  assert.deepEqual(fixture.deleted, ["media-19"]);
  fixture.dom.window.close();
});

test("삭제 반영 대기 중 중지하면 추가 요청 없이 종료", async () => {
  const fixture = library({ resultDelayRounds: 200, stopDuringResultWait: true });
  fixture.start({ count: 2 });
  assert.equal((await fixture.done).phase, "stopped");
  assert.deepEqual(fixture.deleteRequests, ["media-19"]);
  assert.deepEqual(fixture.deleted, []);
  fixture.dom.window.close();
});

test("삭제 실패 진단은 대상 잔존과 스크롤 이탈을 구분하며 재시도를 제한", async () => {
  for (const scrollWithoutDelete of [false, true]) {
    const fixture = library({ size: 40, remove: false, scrollWithoutDelete });
    fixture.start({ count: 2, video: false });
    const state = await fixture.done;
    assert.equal(state.phase, "error");
    assert.equal(state.deleted, 0);
    assert.deepEqual(fixture.deleted, []);
    assert.deepEqual(fixture.deleteRequests, scrollWithoutDelete ? ["media-38"] : ["media-38", "media-38"]);
    assert.match(state.message, /\[삭제 진단\] 대상=media-38/);
    assert.ok(state.message.includes(`대상 DOM=${scrollWithoutDelete ? "없음" : "있음"}`));
    assert.match(state.message, /확인창=0, 확인 클릭=true/);
    assert.match(state.message, /스크롤=.*예상=.*높이=/);
    assert.match(state.message, /이전 이웃=media-38/);
    assert.equal(fixture.dom.window.document.querySelector("#grok-deletion-toast").shadowRoot.querySelector("p").textContent, state.message);
    fixture.dom.window.close();
  }
});

test("400개 요청의 첫 삭제 후 같은 행이 남아도 위치 복구와 집계 완료", async () => {
  const fixture = library({ size: 404, columns: 4, anchorAfterItemRemoval: true });
  fixture.start({ count: 400 });
  const state = await fixture.done;
  assert.equal(state.phase, "done", `${state.message}; 실제 삭제 ${fixture.deleted.length}`);
  assert.equal(state.deleted, 400);
  assert.equal(state.failed, 0);
  assert.deepEqual(fixture.deleted, Array.from({ length: 400 }, (_, index) => `media-${403 - index}`));
  fixture.dom.window.close();
});

test("삭제 진행 중에는 토스트 없이 완료 후 하나의 결과 토스트 표시", async () => {
  const fixture = library({ initialTop: 0, autoConfirm: false });
  const response = fixture.start({ count: 2, testMode: true });
  assert.equal(fixture.dom.window.document.querySelector("#grok-deletion-toast"), null);
  fixture.confirm(response.state.confirmation.id, true);
  const state = await fixture.done;
  const hosts = fixture.dom.window.document.querySelectorAll("#grok-deletion-toast");
  assert.equal(hosts.length, 1);
  const root = hosts[0].shadowRoot;
  assert.equal(root.querySelector("section").getAttribute("role"), "status");
  assert.equal(root.querySelector("p").textContent, state.message);
  assert.match(root.querySelector("strong").textContent, /삭제 완료/);
  assert.equal(fixture.toastTimers.length, 1);
  fixture.toastTimers[0]();
  assert.equal(hosts[0].isConnected, false);
  fixture.dom.window.close();
});

test("오류와 사용자 중지 및 취소에도 결과 토스트 표시 및 직접 닫기", async () => {
  for (const outcome of ["error", "stopped", "cancelled"]) {
    const fixture = library({ initialTop: 0, autoConfirm: false, menuLabel: outcome === "error" ? "공유" : "삭제" });
    const response = fixture.start({ count: 2, testMode: true });
    if (outcome === "stopped") fixture.stop();
    else fixture.confirm(response.state.confirmation.id, outcome !== "cancelled");
    const state = await fixture.done;
    assert.equal(state.phase, outcome);
    const host = fixture.dom.window.document.querySelector("#grok-deletion-toast");
    assert.equal(host.shadowRoot.querySelector("p").textContent, state.message);
    assert.equal(host.shadowRoot.querySelector("section").getAttribute("role"), outcome === "error" ? "alert" : "status");
    host.shadowRoot.querySelector("button").click();
    assert.equal(host.isConnected, false);
    fixture.dom.window.close();
  }
});

test("연속 삭제 토스트는 교체되며 이전 타이머가 새 알림을 지우지 않음", async () => {
  const fixture = library({ initialTop: 0 });
  fixture.start({ count: 1, currentPosition: true });
  await fixture.done;
  const oldHost = fixture.dom.window.document.querySelector("#grok-deletion-toast");
  fixture.start({ count: 1, currentPosition: true });
  await fixture.done;
  const hosts = fixture.dom.window.document.querySelectorAll("#grok-deletion-toast");
  assert.equal(hosts.length, 1);
  assert.equal(oldHost.isConnected, false);
  fixture.toastTimers[0]();
  assert.equal(hosts[0].isConnected, true);
  fixture.dom.window.close();
});

test("테스트 삭제는 실행 요청에 응답한 후 확인을 받음", async () => {
  const fixture = library({ initialTop: 0 });
  fixture.start({ count: 2, testMode: true });
  await fixture.done;
  assert.deepEqual(fixture.confirmationAcknowledgements, [true]);
  fixture.dom.window.close();
});

test("확인 대기 중 삭제하지 않고 동일 작업 승인 후에만 실행", async () => {
  const fixture = library({ initialTop: 0, autoConfirm: false });
  const response = fixture.start({ count: 2, testMode: true });
  assert.equal(response.ok, true);
  assert.equal(response.state.phase, "confirming");
  assert.match(response.state.confirmation.text, /앞쪽 미디어 2개/);
  assert.deepEqual(fixture.deleted, []);
  assert.equal(fixture.confirm("old-request", true).ok, false);
  assert.deepEqual(fixture.deleted, []);
  assert.equal(fixture.confirm(response.state.confirmation.id, true).ok, true);
  assert.equal(fixture.confirm(response.state.confirmation.id, true).ok, false);
  assert.equal((await fixture.done).phase, "done");
  assert.deepEqual(fixture.deleted, ["media-0", "media-1"]);
  fixture.dom.window.close();
});

test("확인 대기 중 중지하면 삭제 없이 종료", async () => {
  const fixture = library({ initialTop: 0, autoConfirm: false });
  fixture.start({ count: 2, testMode: true });
  fixture.stop();
  assert.equal((await fixture.done).phase, "stopped");
  assert.equal(fixture.state().confirmation, null);
  assert.deepEqual(fixture.deleted, []);
  fixture.dom.window.close();
});

test("테스트 모드는 탐색 스크롤 없이 앞쪽 3개를 ID 기준으로 삭제", async () => {
  const fixture = library({ initialTop: 0 });
  fixture.start({ count: 3, testMode: true });
  const state = await fixture.done;
  assert.equal(state.phase, "done", state.message);
  assert.deepEqual(fixture.deleted, ["media-0", "media-1", "media-2"]);
  assert.equal(fixture.scrollCalls(), 3);
  assert.match(fixture.confirmations[0], /테스트 삭제/);
  fixture.dom.window.close();
});

test("테스트 모드는 이미지 유형만 앞에서부터 삭제", async () => {
  const fixture = library({ initialTop: 0 });
  fixture.start({ count: 3, testMode: true, video: false });
  assert.equal((await fixture.done).phase, "done");
  assert.deepEqual(fixture.deleted, ["media-0", "media-2", "media-4"]);
  fixture.dom.window.close();
});

test("테스트 모드는 시작 스크롤 위치와 행 번호가 0이 아니어도 앞쪽 2개 확인", async () => {
  for (const settings of [{ initialTop: 12 }, { initialTop: 0, rowOffset: 1 }, { initialTop: 12, rowOffset: 4 }]) {
    const fixture = library({ ...settings, autoConfirm: false });
    const response = fixture.start({ count: 2, testMode: true });
    assert.equal(response.state.phase, "confirming", response.state.message);
    assert.equal(fixture.scrollCalls(), 0);
    assert.deepEqual(fixture.deleted, []);
    fixture.confirm(response.state.confirmation.id, true);
    const state = await fixture.done;
    assert.equal(state.phase, "done", state.message);
    assert.deepEqual(fixture.deleted, ["media-0", "media-1"]);
    fixture.dom.window.close();
  }
});

test("테스트 모드는 대상 부족이면 스크롤과 삭제 없이 중단", async () => {
  for (const initialTop of [0, 700]) {
    const fixture = library({ initialTop });
    fixture.start({ count: 6, testMode: true });
    assert.equal((await fixture.done).phase, "error");
    assert.deepEqual(fixture.deleted, []);
    assert.equal(fixture.scrollCalls(), 0);
    fixture.dom.window.close();
  }
});

test("테스트 모드 전체 삭제 요청 거부와 확인 취소", async () => {
  const fixture = library({ initialTop: 0, confirm: false });
  assert.equal(fixture.start({ testMode: true }).ok, false);
  fixture.start({ count: 3, testMode: true });
  assert.equal((await fixture.done).phase, "cancelled");
  assert.deepEqual(fixture.deleted, []);
  assert.equal(fixture.scrollCalls(), 0);
  fixture.dom.window.close();
});

test("4열 마지막 단독 항목 삭제 시 지연 재배치 후 나머지 2개도 삭제", async () => {
  const fixture = library({ size: 21, columns: 4, delayedLayout: true });
  fixture.start({ count: 3 });
  const state = await fixture.done;
  assert.equal(state.phase, "done", state.message);
  assert.equal(state.deleted, 3);
  assert.equal(state.failed, 0);
  assert.deepEqual(fixture.deleted, ["media-20", "media-19", "media-18"]);
  fixture.dom.window.close();
});

test("100개 삭제 중 12번째 삭제 재확인 시 늦은 재배치도 복구", async () => {
  const fixture = library({ size: 120, columns: 4, lateAnchorAt: 12 });
  fixture.start({ count: 100 });
  const state = await fixture.done;
  assert.equal(state.phase, "done", `${state.message}; 실제 삭제 ${fixture.deleted.length}`);
  assert.equal(state.deleted, 100);
  assert.deepEqual(fixture.deleted, Array.from({ length: 100 }, (_, index) => `media-${119 - index}`));
  fixture.dom.window.close();
});

test("최종 확인의 반복 재배치는 3회 복구 후 추가 삭제 없이 중단", async () => {
  const fixture = library({ size: 40, columns: 4, lateAnchorAt: 12, lateAnchorRepeats: 10 });
  fixture.start({ count: 20 });
  const state = await fixture.done;
  assert.equal(state.phase, "error");
  assert.equal(state.deleted, 11);
  assert.equal(fixture.deleted.length, 12);
  assert.equal(new Set(fixture.deleted).size, 12);
  assert.match(state.message, /이미 삭제됐을 수/);
  fixture.dom.window.close();
});

test("늦은 재배치 복구 중 중지하면 다음 미디어를 삭제하지 않음", async () => {
  const fixture = library({ size: 40, columns: 4, lateAnchorAt: 12, stopDuringRecovery: true });
  fixture.start({ count: 20 });
  assert.equal((await fixture.done).phase, "stopped");
  assert.equal(fixture.deleted.length, 12);
  fixture.dom.window.close();
});

test("4열 마지막 행 삭제 후 스크롤 고정점이 바뀌어도 5개 삭제와 집계 완료", async () => {
  const fixture = library({ size: 24, columns: 4, anchorAfterRowRemoval: true });
  fixture.start({ count: 5 });
  const state = await fixture.done;
  assert.equal(state.phase, "done", `${state.message}; 실제 삭제: ${fixture.deleted.length}개`);
  assert.equal(state.deleted, 5);
  assert.equal(state.failed, 0);
  assert.deepEqual(fixture.deleted, ["media-23", "media-22", "media-21", "media-20", "media-19"]);
  fixture.dom.window.close();
});

test("마지막 행 복구 시 삭제 안 된 ID가 다시 보이면 성공으로 세지 않음", async () => {
  const fixture = library({ size: 40, columns: 4, phantomLastRow: true });
  fixture.start({ count: 5 });
  const state = await fixture.done;
  assert.equal(state.phase, "error");
  assert.equal(state.deleted, 3);
  assert.deepEqual(fixture.deleted, ["media-39", "media-38", "media-37"]);
  assert.equal(fixture.items.some((item) => item.id === "media-36"), true);
  fixture.dom.window.close();
});

test("마지막 행 복구 중 중지하면 다섯 번째 항목은 삭제하지 않음", async () => {
  const fixture = library({ size: 24, columns: 4, anchorAfterRowRemoval: true, stopDuringRecovery: true });
  fixture.start({ count: 5 });
  const state = await fixture.done;
  assert.equal(state.phase, "stopped");
  assert.deepEqual(fixture.deleted, ["media-23", "media-22", "media-21", "media-20"]);
  fixture.dom.window.close();
});

test("삭제 없이 스크롤로 대상이 DOM에서 사라진 경우 성공으로 세지 않음", async () => {
  const fixture = library({ size: 40, columns: 4, scrollWithoutDelete: true });
  fixture.start({ count: 3 });
  const state = await fixture.done;
  assert.equal(state.phase, "error");
  assert.equal(state.deleted, 0);
  assert.deepEqual(fixture.deleted, []);
  fixture.dom.window.close();
});

test("가상 목록을 처음부터 끝까지 수집하고 오래된 미디어 3개만 삭제", async () => {
  const fixture = library();
  fixture.start({ count: 3 });
  const state = await fixture.done;
  assert.equal(state.phase, "done");
  assert.equal(state.deleted, 3);
  assert.deepEqual(fixture.deleted, ["media-19", "media-18", "media-17"]);
  assert.deepEqual(fixture.confirmations, []);
  fixture.dom.window.close();
});

test("aria-labelledby로 연결된 영구 삭제 메뉴에서 오래된 3개 삭제", async () => {
  const fixture = library({ labelledMenu: true, menuLabel: "영구 삭제" });
  fixture.start({ count: 3 });
  const state = await fixture.done;
  assert.equal(state.phase, "done", state.message);
  assert.deepEqual(fixture.deleted, ["media-19", "media-18", "media-17"]);
  fixture.dom.window.close();
});

test("비동기로 열리는 메뉴를 추가 클릭으로 닫지 않음", async () => {
  const fixture = library({ deferredMenu: true, menuLabel: "영구 삭제" });
  fixture.start({ count: 3 });
  const state = await fixture.done;
  assert.equal(state.phase, "done", state.message);
  assert.deepEqual(fixture.deleted, ["media-19", "media-18", "media-17"]);
  fixture.dom.window.close();
});

for (const count of [null, 20, 200]) {
  test(`전체 범위 확인 및 전체 삭제: count=${count}`, async () => {
    const fixture = library();
    fixture.start({ count });
    const state = await fixture.done;
    assert.equal(state.phase, "done");
    assert.equal(state.deleted, 20);
    assert.deepEqual(fixture.deleted, Array.from({ length: 20 }, (_, index) => `media-${19 - index}`));
    assert.match(fixture.confirmations[0], /전체 20개/);
    fixture.dom.window.close();
  });
}

test("이미지만 선택하면 비디오를 남기고 오래된 이미지부터 삭제", async () => {
  const fixture = library();
  fixture.start({ count: 3, video: false });
  assert.equal((await fixture.done).phase, "done");
  assert.deepEqual(fixture.deleted, ["media-18", "media-16", "media-14"]);
  fixture.dom.window.close();
});

test("다열 그리드도 마지막 행의 마지막 미디어부터 삭제", async () => {
  const fixture = library({ columns: 3 });
  fixture.start({ count: 7 });
  assert.equal((await fixture.done).phase, "done");
  assert.deepEqual(fixture.deleted, ["media-19", "media-18", "media-17", "media-16", "media-15", "media-14", "media-13"]);
  fixture.dom.window.close();
});

test("전체 탐색의 첫 미디어 행이 0이 아니어도 오래된 순서로 삭제 확인", async () => {
  for (const count of [2, null, 200]) {
    const fixture = library({ rowOffset: 1 });
    fixture.start({ count });
    const state = await fixture.done;
    assert.equal(state.phase, "done", state.message);
    const expected = Array.from({ length: count === 2 ? 2 : 20 }, (_, index) => `media-${19 - index}`);
    assert.deepEqual(fixture.deleted, expected);
    assert.equal(fixture.confirmations.length, count === 2 ? 0 : 1);
    fixture.dom.window.close();
  }
});

test("3개 삭제 시 상단 2번 행 누락은 하단 삭제를 차단하지 않음", async () => {
  const fixture = library({ rowOffset: 1, skipRow: 1 });
  fixture.start({ count: 3 });
  const state = await fixture.done;
  assert.equal(state.phase, "done", state.message);
  assert.deepEqual(fixture.deleted, ["media-19", "media-18", "media-17"]);
  assert.deepEqual(fixture.confirmations, []);
  fixture.dom.window.close();
});

test("3개 삭제 대상 구간의 누락은 계속 차단", async () => {
  const fixture = library({ rowOffset: 1, skipRow: 18 });
  fixture.start({ count: 3 });
  assert.equal((await fixture.done).phase, "error");
  assert.deepEqual(fixture.deleted, []);
  assert.deepEqual(fixture.confirmations, []);
  fixture.dom.window.close();
});

test("이미지 3개 삭제 시 유형별 후보 구간을 검사", async () => {
  const fixture = library({ rowOffset: 1, skipRow: 1 });
  fixture.start({ count: 3, video: false });
  assert.equal((await fixture.done).phase, "done");
  assert.deepEqual(fixture.deleted, ["media-18", "media-16", "media-14"]);
  fixture.dom.window.close();
});

test("입력 개수가 수집 개수 이상이면 상단 누락도 계속 차단", async () => {
  for (const count of [19, 200]) {
    const fixture = library({ rowOffset: 1, skipRow: 1 });
    fixture.start({ count });
    assert.equal((await fixture.done).phase, "error");
    assert.deepEqual(fixture.deleted, []);
    assert.deepEqual(fixture.confirmations, []);
    fixture.dom.window.close();
  }
});

test("중간 행 수집이 누락되면 삭제 확인 전에 중단", async () => {
  const fixture = library({ skipRow: 8 });
  fixture.start();
  assert.equal((await fixture.done).phase, "error");
  assert.deepEqual(fixture.deleted, []);
  assert.deepEqual(fixture.confirmations, []);
  fixture.dom.window.close();
});

test("확인 중 목록 순서가 변경되면 삭제 전에 중단", async () => {
  const fixture = library({ reorder: true });
  fixture.start();
  assert.equal((await fixture.done).phase, "error");
  assert.deepEqual(fixture.deleted, []);
  fixture.dom.window.close();
});

test("추가 페이지가 로드되면 새 마지막 항목부터 삭제", async () => {
  const fixture = library({ lateItem: true });
  fixture.start({ count: 2 });
  assert.equal((await fixture.done).phase, "done");
  assert.deepEqual(fixture.deleted, ["media-late", "media-19"]);
  fixture.dom.window.close();
});

test("전체 삭제 확인을 취소하면 미디어를 변경하지 않음", async () => {
  const fixture = library({ confirm: false });
  fixture.start();
  assert.equal((await fixture.done).phase, "cancelled");
  assert.deepEqual(fixture.deleted, []);
  fixture.dom.window.close();
});

test("알 수 없는 삭제 메뉴에서는 다른 메뉴를 누르지 않고 중단", async () => {
  const fixture = library({ menuLabel: "공유" });
  fixture.start();
  assert.equal((await fixture.done).phase, "error");
  assert.deepEqual(fixture.deleted, []);
  fixture.dom.window.close();
});

test("전체 삭제도 재시도 후 미반영이면 다음 항목 삭제 없이 중단", async () => {
  const fixture = library({ remove: false });
  fixture.start();
  const state = await fixture.done;
  assert.equal(state.phase, "error");
  assert.equal(state.deleted, 0);
  assert.deepEqual(fixture.deleteRequests, ["media-19", "media-19"]);
  fixture.dom.window.close();
});

test("사이트 확인창이 없는 영어 삭제 메뉴도 처리", async () => {
  const fixture = library({ dialog: false, menuLabel: "Delete" });
  fixture.start({ count: 1 });
  assert.equal((await fixture.done).phase, "done");
  assert.deepEqual(fixture.deleted, ["media-19"]);
  fixture.dom.window.close();
});

test("사이트 확인창 직전 중지하면 확인 버튼을 누르지 않음", async () => {
  const fixture = library({ onDialog: (stop) => stop() });
  fixture.start();
  assert.equal((await fixture.done).phase, "stopped");
  assert.deepEqual(fixture.deleted, []);
  fixture.dom.window.close();
});

test("탐색 중 중지와 동시 실행 방지", async () => {
  const fixture = library();
  assert.equal(fixture.start().ok, true);
  assert.equal(fixture.start().ok, false);
  fixture.stop();
  assert.equal((await fixture.done).phase, "stopped");
  assert.deepEqual(fixture.deleted, []);
  assert.deepEqual(fixture.confirmations, []);
  fixture.dom.window.close();
});

test("현재 위치에서 5개씩 연속 삭제하며 전체 재탐색과 추가 확인 없음", async () => {
  const fixture = library({ size: 40, columns: 4, initialTop: 800, autoConfirm: false });
  for (let round = 0; round < 2; round += 1) {
    const previousScrolls = fixture.scrollCalls();
    fixture.start({ count: 5, currentPosition: true });
    const state = await fixture.done;
    assert.equal(state.phase, "done", state.message);
    assert.equal(state.deleted, 5);
    assert.equal(fixture.scrollCalls() - previousScrolls, 5);
  }
  assert.deepEqual(fixture.deleted, Array.from({ length: 10 }, (_, index) => `media-${39 - index}`));
  assert.deepEqual(fixture.confirmations, []);
  fixture.dom.window.close();
});

test("현재 위치 대상 부족 시 탐색하거나 일부 삭제하지 않음", async () => {
  const fixture = library({ initialTop: 1800 });
  fixture.start({ count: 5, currentPosition: true });
  assert.equal((await fixture.done).phase, "error");
  assert.equal(fixture.scrollCalls(), 0);
  assert.deepEqual(fixture.deleted, []);
  fixture.dom.window.close();
});

test("현재 위치 모드 빈 개수와 테스트 모드 동시 선택 거부", () => {
  const fixture = library();
  assert.equal(fixture.start({ currentPosition: true }).ok, false);
  assert.equal(fixture.start({ count: 2, currentPosition: true, testMode: true }).ok, false);
  fixture.dom.window.close();
});

test("잘못된 개수는 탐색 전에 거부", () => {
  const fixture = library();
  for (const count of [0, -1, 1.5, "3", Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(fixture.start({ count }).ok, false);
  }
  assert.equal(fixture.start({ image: false, video: false }).ok, false);
  assert.equal(fixture.state(), undefined);
  fixture.dom.window.close();
});

function popup(url = "https://grok.com/library", initialState, startState) {
  const dom = new JSDOM(readFileSync(path.join(__dirname, "..", "popup.html"), "utf8"), { runScripts: "outside-only" });
  const { window } = dom;
  const messages = [];
  let listener;
  let closed = false;
  window.close = () => { closed = true; };
  window.chrome = {
    runtime: {
      getManifest: () => ({ version: "1.0.3" }),
      onMessage: { addListener(callback) { listener = callback; } }
    },
    tabs: {
      query(_query, callback) { callback([{ id: 7, url }]); },
      sendMessage(_tabId, message, callback) {
        messages.push(message);
        callback(message.type === "GET_GROK_DOWNLOAD_STATE"
          ? initialState || { phase: "idle", operation: "download", running: false, downloaded: 0, failed: 0, found: 0 }
          : { ok: true, state: message.type === "START_GROK_DELETE" ? startState : undefined });
      }
    }
  };
  window.eval(readFileSync(path.join(__dirname, "..", "popup.js"), "utf8"));
  return {
    document: window.document, messages, closed: () => closed,
    progress(state, tabId = 7) { listener({ type: "GROK_DOWNLOAD_PROGRESS", state }, { tab: { id: tabId } }); }
  };
}

test("팝업은 삭제 개수와 다운로드 스크롤 횟수를 별도로 전송", () => {
  const fixture = popup();
  fixture.document.querySelector("#max-scrolls").value = "99";
  fixture.document.querySelector("#delete-count").value = "3";
  fixture.document.querySelector("#delete").click();
  const message = fixture.messages.at(-1);
  assert.equal(message.type, "START_GROK_DELETE");
  assert.equal(message.options.count, 3);
  assert.equal(message.options.maxScrolls, undefined);
  assert.equal(fixture.closed(), true);
});

test("팝업 테스트 모드는 개수 필수이며 열린 채로 상태를 조회", () => {
  const fixture = popup();
  fixture.document.querySelector("#test-delete").click();
  fixture.document.querySelector("#delete").click();
  assert.equal(fixture.messages.length, 1);
  fixture.document.querySelector("#delete-count").value = "3";
  fixture.document.querySelector("#delete").click();
  const request = fixture.messages.find((message) => message.type === "START_GROK_DELETE");
  assert.equal(request.options.testMode, true);
  assert.equal(request.options.count, 3);
  assert.equal(fixture.closed(), false);
  assert.equal(fixture.messages.at(-1).type, "GET_GROK_DOWNLOAD_STATE");
});

test("현재 위치 팝업은 개수 필수이며 테스트 모드와 배타적이고 실행 후 유지", () => {
  const fixture = popup();
  fixture.document.querySelector("#test-delete").click();
  fixture.document.querySelector("#current-position").click();
  assert.equal(fixture.document.querySelector("#test-delete").checked, false);
  fixture.document.querySelector("#delete").click();
  assert.equal(fixture.messages.length, 1);
  fixture.document.querySelector("#delete-count").value = "5";
  fixture.document.querySelector("#delete").click();
  const request = fixture.messages.find((message) => message.type === "START_GROK_DELETE");
  assert.equal(request.options.currentPosition, true);
  assert.equal(request.options.testMode, false);
  assert.equal(request.options.count, 5);
  assert.equal(fixture.closed(), false);
  assert.equal(fixture.document.querySelector("#current-position").checked, true);
  fixture.document.querySelector("#test-delete").click();
  assert.equal(fixture.document.querySelector("#current-position").checked, false);
});

test("팝업 재개 시 확인 내용 복원 및 명시적 승인 또는 취소 전달", () => {
  const state = { operation: "delete", phase: "confirming", running: true, found: 2, deleted: 0, failed: 0,
    message: "삭제 확인 대기", confirmation: { id: "request-2", text: "앞쪽 미디어 2개 영구 삭제" } };
  for (const confirmed of [true, false]) {
    const fixture = popup(undefined, state);
    assert.equal(fixture.document.querySelector("#delete-confirmation").hidden, false);
    assert.match(fixture.document.querySelector("#confirmation-text").textContent, /2개/);
    assert.equal(fixture.messages.length, 1);
    fixture.document.querySelector(confirmed ? "#confirm-delete" : "#cancel-delete").click();
    const request = fixture.messages.find((message) => message.type === "CONFIRM_GROK_DELETE");
    assert.equal(request.id, "request-2");
    assert.equal(request.confirmed, confirmed);
    assert.equal(fixture.closed(), false);
  }
});

test("테스트 시작 응답의 확인 상태를 진행 알림 없이 즉시 표시", () => {
  const state = { operation: "delete", phase: "confirming", running: true, found: 2, deleted: 0, failed: 0,
    message: "삭제 확인 대기", confirmation: { id: "request-2", text: "앞쪽 미디어 2개 영구 삭제" } };
  const fixture = popup(undefined, undefined, state);
  fixture.document.querySelector("#test-delete").click();
  fixture.document.querySelector("#delete-count").value = "2";
  fixture.document.querySelector("#delete").click();
  assert.equal(fixture.document.querySelector("#message").textContent, state.message);
  assert.equal(fixture.document.querySelector("#delete-confirmation").hidden, false);
  assert.equal(fixture.closed(), false);
});

test("팝업 빈 삭제 개수는 전체, 잘못된 개수는 전송하지 않음", () => {
  for (const value of ["", "0", "-1", "1.5"]) {
    const fixture = popup();
    fixture.document.querySelector("#delete-count").value = value;
    fixture.document.querySelector("#delete").click();
    assert.equal(fixture.closed(), value === "");
    if (value === "") assert.equal(fixture.messages.at(-1).options.count, null);
    else assert.equal(fixture.messages.length, 1);
  }
});

test("삭제 중 팝업 상태 복원과 다른 탭 진행 알림 무시", () => {
  const fixture = popup();
  const state = { operation: "delete", phase: "deleting", running: true, deleted: 2, downloaded: 0, failed: 0, found: 5, message: "삭제 중" };
  fixture.progress(state, 8);
  assert.equal(fixture.document.querySelector("#handled-label").textContent, "요청");
  fixture.progress(state);
  assert.equal(fixture.document.querySelector("#handled-label").textContent, "삭제");
  assert.equal(fixture.document.querySelector("#downloaded").textContent, "2");
  assert.equal(fixture.document.querySelector("#progress").style.width, "40%");
  assert.equal(fixture.document.querySelector("#delete").disabled, true);
  assert.equal(fixture.document.querySelector("#stop").hidden, false);
});

test("라이브러리가 아닌 탭에서는 삭제 비활성화", () => {
  const fixture = popup("https://example.com");
  assert.equal(fixture.document.querySelector("#delete").disabled, true);
  assert.equal(fixture.messages.length, 0);
});

test("다운로드 시작 메시지 규격 유지", () => {
  const fixture = popup();
  fixture.document.querySelector("#max-scrolls").value = "4";
  fixture.document.querySelector("#start").click();
  assert.equal(fixture.messages.at(-1).type, "START_GROK_DOWNLOAD");
  assert.equal(fixture.messages.at(-1).options.maxScrolls, 4);
  assert.equal(fixture.closed(), true);
});

test("테스트 확인을 기다리는 동안 스크롤 위치가 바뀌면 삭제 없이 중단", async () => {
  const fixture = library({ initialTop: 12, autoConfirm: false });
  const response = fixture.start({ count: 2, testMode: true });
  fixture.dom.window.document.querySelector("#library").scrollTop = 40;
  fixture.confirm(response.state.confirmation.id, true);
  const state = await fixture.done;
  assert.equal(state.phase, "error");
  assert.match(state.message, /목록 위치가 변경/);
  assert.deepEqual(fixture.deleted, []);
  assert.equal(fixture.scrollCalls(), 0);
  fixture.dom.window.close();
});