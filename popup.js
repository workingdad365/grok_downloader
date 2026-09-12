const elements = {
  images: document.querySelector("#images"),
  videos: document.querySelector("#videos"),
  maxScrolls: document.querySelector("#max-scrolls"),
  deleteCount: document.querySelector("#delete-count"),
  testDelete: document.querySelector("#test-delete"),
  currentPosition: document.querySelector("#current-position"),
  confirmation: document.querySelector("#delete-confirmation"),
  confirmationText: document.querySelector("#confirmation-text"),
  confirmDelete: document.querySelector("#confirm-delete"),
  cancelDelete: document.querySelector("#cancel-delete"),
  delete: document.querySelector("#delete"),
  handledLabel: document.querySelector("#handled-label"),
  start: document.querySelector("#start"),
  stop: document.querySelector("#stop"),
  message: document.querySelector("#message"),
  count: document.querySelector("#count"),
  found: document.querySelector("#found"),
  downloaded: document.querySelector("#downloaded"),
  failed: document.querySelector("#failed"),
  progress: document.querySelector("#progress"),
  status: document.querySelector("#status"),
  help: document.querySelector("#help"),
  version: document.querySelector("#version")
};

let tabId = null;
let confirmationId = null;

elements.version.textContent = `v${chrome.runtime.getManifest().version}`;

function render(state) {
  confirmationId = state.confirmation?.id || null;
  elements.confirmation.hidden = !confirmationId;
  elements.confirmationText.textContent = state.confirmation?.text || "";
  elements.confirmDelete.disabled = !confirmationId;
  elements.cancelDelete.disabled = !confirmationId;
  const inactive = state.phase === "idle";
  const deleting = state.operation === "delete";
  const completed = deleting ? (state.deleted || 0) : state.downloaded;
  elements.status.classList.toggle("inactive", inactive);
  elements.message.textContent = inactive ? "작업 대기 중" : state.message;
  elements.message.title = elements.message.textContent;
  elements.count.textContent = inactive ? "-" : `${state.found}개`;
  elements.found.textContent = inactive ? "-" : state.found;
  elements.handledLabel.textContent = deleting ? "삭제" : "요청";
  elements.downloaded.textContent = inactive ? "-" : completed;
  elements.failed.textContent = inactive ? "-" : state.failed;
  elements.start.hidden = state.running;
  elements.stop.hidden = !state.running;
  elements.images.disabled = state.running;
  elements.videos.disabled = state.running;
  elements.maxScrolls.disabled = state.running;
  elements.deleteCount.disabled = state.running;
  elements.testDelete.disabled = state.running;
  elements.currentPosition.disabled = state.running;
  elements.delete.disabled = state.running;
  elements.progress.classList.toggle("scanning", state.phase === "scanning");
  const handled = completed + state.failed;
  elements.progress.style.width = ["downloading", "deleting", "stopped", "error"].includes(state.phase) && state.found
    ? `${Math.round((handled / state.found) * 100)}%`
    : state.phase === "done" ? "100%" : "";
}

function send(message, callback = () => {}) {
  if (tabId === null) return;
  chrome.tabs.sendMessage(tabId, message, callback);
}

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab?.url?.startsWith("https://grok.com/library")) {
    elements.start.disabled = true;
    elements.message.textContent = "라이브러리 페이지가 아닙니다";
    return;
  }
  tabId = tab.id;
  send({ type: "GET_GROK_DOWNLOAD_STATE" }, (state) => {
    if (chrome.runtime.lastError || !state) {
      elements.start.disabled = true;
      elements.message.textContent = "페이지를 새로고침해 주세요";
      return;
    }
    render(state);
    elements.help.textContent = "탐색 중에는 라이브러리 탭을 닫지 마세요.";
  });
});

elements.start.addEventListener("click", () => {
  if (!elements.images.checked && !elements.videos.checked) return;
  const value = elements.maxScrolls.value.trim();
  const maxScrolls = value === "" ? null : Number(value);
  if (maxScrolls !== null && (!Number.isInteger(maxScrolls) || maxScrolls < 1)) {
    elements.maxScrolls.focus();
    return;
  }
  send({
    type: "START_GROK_DOWNLOAD",
    options: { image: elements.images.checked, video: elements.videos.checked, maxScrolls }
  });
  window.close();
});

elements.stop.addEventListener("click", () => send({ type: "STOP_GROK_DOWNLOAD" }));

function updateDeletionMode() {
  const local = elements.testDelete.checked || elements.currentPosition.checked;
  elements.deleteCount.required = local;
  elements.deleteCount.placeholder = local ? "개수 필수" : "비워두면 전체";
  elements.delete.textContent = elements.testDelete.checked ? "앞에서부터 테스트 삭제"
    : elements.currentPosition.checked ? "현재 위치에서 즉시 삭제" : "오래된 순서로 삭제";
}

elements.testDelete.addEventListener("change", () => {
  if (elements.testDelete.checked) elements.currentPosition.checked = false;
  updateDeletionMode();
});
elements.currentPosition.addEventListener("change", () => {
  if (elements.currentPosition.checked) elements.testDelete.checked = false;
  updateDeletionMode();
});

elements.delete.addEventListener("click", () => {
  if (!elements.images.checked && !elements.videos.checked) {
    elements.message.textContent = "삭제할 이미지 또는 비디오 유형을 선택해 주세요";
    elements.status.classList.remove("inactive");
    return;
  }
  const input = elements.deleteCount;
  const value = input.value.trim();
  const count = value === "" ? null : Number(value);
  const testMode = elements.testDelete.checked;
  const currentPosition = elements.currentPosition.checked;
  if (!input.validity.valid || ((testMode || currentPosition) && count === null) || (count !== null && (!Number.isSafeInteger(count) || count < 1))) {
    elements.message.textContent = "삭제 개수는 1 이상의 정수로 입력해 주세요";
    elements.status.classList.remove("inactive");
    input.reportValidity();
    input.focus();
    return;
  }
  render({ operation: "delete", phase: "starting", running: true, found: 0, deleted: 0, failed: 0, message: "삭제 요청 전송 중" });
  let responded = false;
  const timeout = setTimeout(() => {
    if (responded) return;
    elements.message.textContent = "페이지 응답이 없습니다. Grok 탭과 확장 프로그램을 새로고침한 후 다시 확인해 주세요";
  }, 8000);
  send({
    type: "START_GROK_DELETE",
    options: { image: elements.images.checked, video: elements.videos.checked, count, testMode, currentPosition }
  }, (response) => {
    responded = true;
    clearTimeout(timeout);
    const error = chrome.runtime.lastError;
    if (error || !response?.ok) {
      render({ operation: "delete", phase: "error", running: false, found: 0, deleted: 0, failed: 0, message: error?.message || response?.error || "삭제를 시작하지 못했습니다" });
      return;
    }
    if (response.state) {
      render(response.state);
      if (!testMode && !currentPosition && response.state.phase === "scanning") window.close();
      return;
    }
    if (testMode || currentPosition) {
      send({ type: "GET_GROK_DOWNLOAD_STATE" }, (state) => {
        const error = chrome.runtime.lastError;
        if (error || !state) {
          elements.message.textContent = error?.message || "삭제 상태를 조회하지 못했습니다";
          return;
        }
        render(state);
      });
    } else window.close();
  });
});

function answerDeletion(confirmed) {
  if (!confirmationId) return;
  elements.confirmDelete.disabled = true;
  elements.cancelDelete.disabled = true;
  send({ type: "CONFIRM_GROK_DELETE", id: confirmationId, confirmed }, (response) => {
    const error = chrome.runtime.lastError;
    if (error || !response?.ok) {
      elements.message.textContent = error?.message || response?.error || "삭제 확인을 전달하지 못했습니다";
      return;
    }
    send({ type: "GET_GROK_DOWNLOAD_STATE" }, (state) => {
      const error = chrome.runtime.lastError;
      if (error || !state) {
        elements.message.textContent = error?.message || "삭제 상태를 조회하지 못했습니다";
        return;
      }
      render(state);
    });
  });
}

elements.confirmDelete.addEventListener("click", () => answerDeletion(true));
elements.cancelDelete.addEventListener("click", () => answerDeletion(false));

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "GROK_DOWNLOAD_PROGRESS" && sender.tab?.id === tabId) render(message.state);
});
