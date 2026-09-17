// 今日の残り（ページと通知の service worker の両方で使う）
// 端末に残した状態（snapshot）から、単語帳ごとに「今日の分」の残り語数を数える。
// 数え方は index.html の todayDeck と同じ：FSRS の期限の語（最大 100）＋今日の新しい語。
// snapshot = { test, books: [{b, label, rows}], bookOf: {行番号: b}, fsrs: {行番号: [安定度, 難易度, 最後の日]},
//              plans: {b: {date, rows}}, url }
var WC_REVIEW_MAX = 100;
function wcIso(d) { return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
function wcDays(a, b) { return Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000); }
function wcLeft(snap, today) {
  today = today || wcIso(new Date());
  var fsrs = snap.fsrs || {}, out = [];
  (snap.books || []).forEach(function (bk) {
    var due = 0;
    Object.keys(fsrs).forEach(function (row) {
      var st = fsrs[row];
      if (snap.bookOf[row] !== bk.b || st[2] === today) return;
      if (wcDays(st[2], today) >= Math.max(1, Math.round(st[0]))) due++;
    });
    var plan = (snap.plans || {})[bk.b], fresh;
    if (plan && plan.date === today) {
      fresh = plan.rows.filter(function (r) { return !fsrs[r]; }).length;
    } else {
      var unseen = bk.rows.filter(function (r) { return !fsrs[r]; }).length;
      fresh = Math.ceil(unseen / Math.max(1, wcDays(today, snap.test)));
    }
    out.push({ b: bk.b, label: bk.label, n: Math.min(due, WC_REVIEW_MAX) + fresh });
  });
  return out;
}
// 通知の文面：「今日の残り　英 42 語・古文 12 語」
function wcText(left) {
  var parts = left.filter(function (x) { return x.n > 0; }).map(function (x) { return (x.b === "k" ? "古文 " : "英 ") + x.n + " 語"; });
  return parts.length ? "今日の残り　" + parts.join("・") : "";
}
