// 単語チェックの service worker：毎日の通知だけを扱う（ページの読み込みには手を出さない）
// 通知サーバー（Cloudflare Worker）から届いたら、端末に残した状態から「今日の残り」を数えて出す。
importScripts("left.js");

var STATE_CACHE = "wc-state", STATE_URL = "state.json";

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

function readState() {
  return caches.open(STATE_CACHE)
    .then(function (c) { return c.match(STATE_URL); })
    .then(function (r) { return r ? r.json() : null; })
    .catch(function () { return null; });
}

self.addEventListener("push", function (e) {
  e.waitUntil(readState().then(function (snap) {
    var body = "今日の単語チェックをやろう", total = 0;
    if (snap) {
      var left = wcLeft(snap);
      total = left.reduce(function (a, x) { return a + x.n; }, 0);
      body = total ? wcText(left) : "今日の分は終わり。もっとやってもOK";
    }
    if (self.navigator.setAppBadge) {
      (total ? self.navigator.setAppBadge(total) : self.navigator.clearAppBadge()).catch(function () {});
    }
    // iOS は届いたら必ず通知を出す決まり（出さないと購読が切られる）
    return self.registration.showNotification("単語チェック", {
      body: body, tag: "daily", data: { url: snap && snap.url }
    });
  }));
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) { if ("focus" in list[i]) return list[i].focus(); }
    return self.clients.openWindow(url);
  }));
});
