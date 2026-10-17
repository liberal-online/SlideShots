const urls = new Map();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !["makePdfUrl", "revokePdfUrl"].includes(message?.type)) return;
  (async () => {
    if (message.type === "makePdfUrl") {
      const blob = await downloadStore.get(message.key);
      if (!(blob instanceof Blob)) throw new Error("PDFの一時データを取得できません。");
      const url = URL.createObjectURL(blob);
      urls.set(message.key, url);
      return { url };
    }
    const url = urls.get(message.key);
    if (url) URL.revokeObjectURL(url);
    urls.delete(message.key);
    return {};
  })().then((result) => respond({ ok: true, ...result }), (error) => respond({ ok: false, error: error.message }));
  return true;
});
