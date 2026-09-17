// 単語チェックの service worker：毎日の通知と、ページを常に最新で開くこと
// ホーム画面のアプリは HTTP のキャッシュで古いページが出続けるので（2026-09-17 本人指摘）、
// ページ本体と left.js は毎回ネットから取り直す。つながらなければキャッシュ。
// 通知サーバー（Cloudflare Worker）から届いたら、端末に残した状態から「今日の残り」を数えて出す。
importScripts("left.js");

var STATE_CACHE = "wc-state", STATE_URL = "state.json";

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener("fetch", function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  var fresh = req.mode === "navigate" || /\/(left\.js|version\.txt)$/.test(url.pathname);
  if (!fresh) return;
  // navigate の Request は設定を付けて作り直せないので URL で取る（# の後ろはもともと送られない）
  e.respondWith(fetch(req.url, { cache: "no-store", credentials: "same-origin" }).catch(function () { return fetch(req); }));
});

function readState() {
  return caches.open(STATE_CACHE)
    .then(function (c) { return c.match(STATE_URL); })
    .then(function (r) { return r ? r.json() : null; })
    .catch(function () { return null; });
}

// 講師アプリ（teacher.html）が置く氏名の対応表（端末の中だけ）
function readTeacher() {
  return caches.open("wc-teacher")
    .then(function (c) { return c.match("teacher.json"); })
    .then(function (r) { return r ? r.json() : null; })
    .catch(function () { return null; });
}

self.addEventListener("push", function (e) {
  var msg = null;
  try { msg = e.data ? e.data.json() : null; } catch (err) { msg = null; }
  if (msg && msg.t === "rec") {
    // 講師への通知：生徒が回を終えた（氏名は端末の対応表から）
    e.waitUntil(readTeacher().then(function (tc) {
      var name = (tc && tc.names && tc.names[msg.c]) || "生徒 " + msg.c;
      var kinds = ["今日の分", "もっとやる", "ミスだけ", "もう一周", "苦手語"];
      var body = (msg.b === "k" ? "古文" : "英") + "・" + (kinds[msg.k] || "") + "　" + msg.n + " 回答（○ " + msg.ok + "）";
      return self.registration.showNotification(name + " が単語チェック", {
        body: body, tag: "rec-" + msg.c, data: { url: tc && tc.url }
      });
    }));
    return;
  }
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
