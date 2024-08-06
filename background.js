chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'https://github.com/tyrynmyryn/jrpc-viewer' });
});
