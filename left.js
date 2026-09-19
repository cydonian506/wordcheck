// 今日の分の決め方と、今日の残り（ページと通知の service worker の両方で使う）
//
// 本人決定（2026-09-17）：新しい語は期間の前半で出し切る（均等割だとテスト前日に初めて見る語が出るため）。
//   - 前半（宿題の日数の半分、最後の日は含めない）：まだやっていない語を 残り÷前半の残り日数 ずつ
//   - 後半：FSRS の期限の語だけ（出遅れてまだやっていない語があれば全部出す）
//   - テストの前日（と当日）：テスト範囲を全部 1 周（今日もうやった語は除く）＋期限の語
// snapshot = { handout, test, books: [{b, label, rows, t, daily}], bookOf: {行番号: b},
//              fsrs: {行番号: [安定度, 難易度, 最後の日]}, plans: {b: {date, rows}}, pend: [今日最後が ✕ の行番号], url }
//   t はテスト範囲（次週）の行番号。古いデータで無ければ rows 全部を使う
var WC_REVIEW_MAX = 100, WC_FINAL_REVIEW_MAX = 50, WC_INTRO_RATIO = 0.5;   // 前日は範囲の 1 周が主なので期限の語を絞る
function wcIso(d) { return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
function wcDays(a, b) { return Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000); }

// 今日が期間のどこか。{kind: "intro"|"review"|"final", left: 前半の残り日数（今日を含む）}
function wcPhase(handout, test, today) {
  if (wcDays(today, test) <= 1) return { kind: "final", left: 0 };
  if (!handout) return { kind: "intro", left: wcDays(today, test) - 1 };   // 古いデータ：前日まで均等
  var hw = Math.max(1, wcDays(handout, test) - 1);                         // 宿題の日数
  var intro = Math.max(1, Math.min(hw - 1, Math.ceil(hw * WC_INTRO_RATIO)));
  var left = intro - Math.max(1, wcDays(handout, today)) + 1;              // 渡した日にやった分は 1 日目に数える
  return left >= 1 ? { kind: "intro", left: left } : { kind: "review", left: 0 };
}
// 今日出す新しい語の数（final では使わない）
function wcFreshCount(unseen, phase) {
  return phase.kind === "intro" ? Math.ceil(unseen / Math.max(1, phase.left)) : unseen;
}
// 期限が来ているか
function wcDue(st, today) { return st[2] !== today && wcDays(st[2], today) >= Math.max(1, Math.round(st[0])); }
// テストの前日の 1 周：テスト範囲のうち今日まだやっていない語＋まだやっていない語（範囲全体）
function wcFinalRows(bk, fsrs, today) {
  var seen = {}, out = [];
  (bk.t || bk.rows).concat(bk.rows).forEach(function (r) {
    var st = fsrs[r];
    if (seen[r]) return;
    seen[r] = 1;
    if (!st || (st[2] !== today && (bk.t || bk.rows).indexOf(r) >= 0)) out.push(r);
  });
  return out;
}

// 毎日 daily 語ずつ番号順に足す単語帳（2026-09-19 本人決定、渡辺）。
//   渡した日を 1 日目として、今日までに daily×日数 語（テスト範囲の中で）。休んだ日の分は翌日に回る。
//   前週の範囲でまだやっていない語は先に全部出す。返すのは今日出す新しい語の行番号（番号順）
function wcDailyRows(bk, fsrs, handout, today) {
  var t = bk.t || bk.rows, inT = {}, seenT = 0;
  t.forEach(function (r) { inT[r] = 1; if (fsrs[r]) seenT++; });
  var k = Math.max(1, wcDays(handout, today) + 1);
  var room = Math.max(0, Math.min(t.length, bk.daily * k) - seenT);
  var old = bk.rows.filter(function (r) { return !inT[r] && !fsrs[r]; });
  return old.concat(t.filter(function (r) { return !fsrs[r]; }).slice(0, room));
}

function wcLeft(snap, today) {
  today = today || wcIso(new Date());
  var fsrs = snap.fsrs || {}, out = [], phase = wcPhase(snap.handout, snap.test, today);
  (snap.books || []).forEach(function (bk) {
    var n;
    if (phase.kind === "final") {
      var fin = wcFinalRows(bk, fsrs, today), inFin = {};
      fin.forEach(function (r) { inFin[r] = 1; });
      var due = 0;
      Object.keys(fsrs).forEach(function (row) { if (snap.bookOf[row] === bk.b && !inFin[row] && wcDue(fsrs[row], today)) due++; });
      n = fin.length + Math.min(due, WC_FINAL_REVIEW_MAX);
    } else {
      var d = 0;
      Object.keys(fsrs).forEach(function (row) { if (snap.bookOf[row] === bk.b && wcDue(fsrs[row], today)) d++; });
      var plan = (snap.plans || {})[bk.b], fresh;
      if (plan && plan.date === today) fresh = plan.rows.filter(function (r) { return !fsrs[r]; }).length;
      else if (bk.daily && snap.handout) fresh = wcDailyRows(bk, fsrs, snap.handout, today).length;
      else fresh = wcFreshCount(bk.rows.filter(function (r) { return !fsrs[r]; }).length, phase);
      n = Math.min(d, WC_REVIEW_MAX) + fresh;
    }
    // 今日 ✕ のまま終わった語（全部 ○ にするまで残る。今日やった語なので上の数には入っていない）
    n += (snap.pend || []).filter(function (r) { return snap.bookOf[r] === bk.b; }).length;
    out.push({ b: bk.b, label: bk.label, n: n });
  });
  return out;
}
// 通知の文面：「今日の残り　英 42 語・古文 12 語」
function wcText(left) {
  var parts = left.filter(function (x) { return x.n > 0; }).map(function (x) { return (x.b === "k" ? "古文 " : "英 ") + x.n + " 語"; });
  return parts.length ? "今日の残り　" + parts.join("・") : "";
}
