const pendingFilenames = [];

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const index = pendingFilenames.findIndex((item) => item.url === downloadItem.url);
  if (index === -1) return;

  const [{ filename }] = pendingFilenames.splice(index, 1);
  suggest({ filename, conflictAction: "uniquify" });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "DOWNLOAD_MEDIA") return false;

  pendingFilenames.push({ url: message.url, filename: message.filename });
  chrome.downloads.download(
    {
      url: message.url,
      filename: message.filename,
      conflictAction: "uniquify",
      saveAs: false
    },
    (downloadId) => {
      const error = chrome.runtime.lastError?.message;
      if (error) {
        const index = pendingFilenames.findIndex(
          (item) => item.url === message.url && item.filename === message.filename
        );
        if (index !== -1) pendingFilenames.splice(index, 1);
      }
      sendResponse(error ? { ok: false, error } : { ok: true, downloadId });
    }
  );

  return true;
});
