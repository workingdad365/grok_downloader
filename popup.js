const elements = {
  images: document.querySelector("#images"),
  videos: document.querySelector("#videos"),
  maxScrolls: document.querySelector("#max-scrolls"),
  start: document.querySelector("#start"),
  stop: document.querySelector("#stop"),
  message: document.querySelector("#message"),
  count: document.querySelector("#count"),
  found: document.querySelector("#found"),
  downloaded: document.querySelector("#downloaded"),
  failed: document.querySelector("#failed"),
  progress: document.querySelector("#progress"),
  status: document.querySelector("#status"),
  help: document.querySelector("#help")
};

let tabId = null;

function render(state) {
  const inactive = state.phase === "idle";
  elements.status.classList.toggle("inactive", inactive);
  elements.message.textContent = inactive ? "다운로드 시작 후 집계합니다" : state.message;
  elements.count.textContent = inactive ? "-" : `${state.found}개`;
  elements.found.textContent = inactive ? "-" : state.found;
  elements.downloaded.textContent = inactive ? "-" : state.downloaded;
  elements.failed.textContent = inactive ? "-" : state.failed;
  elements.start.hidden = state.running;
  elements.stop.hidden = !state.running;
  elements.images.disabled = state.running;
  elements.videos.disabled = state.running;
  elements.maxScrolls.disabled = state.running;
  elements.progress.classList.toggle("scanning", state.phase === "scanning");
  const handled = state.downloaded + state.failed;
  elements.progress.style.width = state.phase === "downloading" && state.found
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

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "GROK_DOWNLOAD_PROGRESS") render(message.state);
});
