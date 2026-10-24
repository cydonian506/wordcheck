// 今日の分の決め方と、今日の残り（ページと通知の service worker の両方で使う）
//
// 本人決定（2026-10-25）：
//   - 新しい語を足すのは「渡した日（＝前のテストの日）の翌日〜テストの前々日」だけ。休みの曜日・日付も除く。
//     テストの前日に覚えた語は翌日のテストに間に合わず、テストの日に新しい語を入れると見直しの邪魔になるため
//   - 毎日の量は単語帳ごとの規定量（計画の daily）。範囲は 規定量×足す日の数 で組んであるので、1 日の量＝規定量になる。
//     範囲と足す日の数が合わない期間（足し方を変えた直後など）は、範囲÷足す日の数 に自動で合わせる
//   - テストの前日：テスト範囲を全部 1 周（今日もうやった語は除く）＋期限の語
//   - テストの日（＝次の期間を渡した日）：今日のテストの範囲（前週の範囲）を 1 周＋期限の語。新しい語は無し
//   規定量の無い単語帳は、範囲を足す日に均等に割る（2026-09-17〜の「前半で出し切る」は 2026-10-25 にやめた）
// snapshot = { handout, test, books: [{b, label, rows, t, daily}], bookOf: {行番号: b},
//              fsrs: {行番号: [安定度, 難易度, 最後の日]}, plans: {b: {date, rows}}, pend: [学習ステップの途中の行番号（前の日のぶんも）], url }
//   t はテスト範囲（次週）の行番号。古いデータで無ければ rows 全部を使う
var WC_REVIEW_MAX = 100, WC_FINAL_REVIEW_MAX = 50, WC_INTRO_RATIO = 1;     // 前日は範囲の 1 周が主なので期限の語を絞る
// 本人決定（2026-10-10）：1 日の切り替わりは朝 3 時（夜中の 0〜3 時は前の日のぶん）
var WC_DAY_START_H = 3;
function wcDayOf(ms) { return wcIso(new Date(ms - WC_DAY_START_H * 3600000)); }
function wcToday() { return wcDayOf(Date.now()); }
function wcIso(d) { return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
function wcDays(a, b) { return Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000); }

// 今日が期間のどこか。{kind: "intro"|"review"|"final", left: 新しい語を出す日の残り（今日を含む）, intro: その日数}
// final の lap："test"＝テスト範囲（次週）を 1 周、"prev"＝渡した日（テストの日）に前週の範囲を 1 周
function wcPhase(handout, test, today) {
  if (wcDays(today, test) <= 1) return { kind: "final", left: 0, lap: "test" };
  if (handout && today <= handout) return { kind: "final", left: 0, lap: "prev" };
  if (!handout) return { kind: "intro", left: wcDays(today, test) - 1, intro: 0 };   // 古いデータ：前日まで均等
  var hw = Math.max(1, wcDays(handout, test) - 1);                         // 宿題の日数
  var intro = Math.max(1, Math.min(hw - 1, Math.ceil(hw * WC_INTRO_RATIO)));
  var left = intro - wcDays(handout, today) + 1;                           // 渡した日の翌日が 1 日目
  return left >= 1 ? { kind: "intro", left: left, intro: intro } : { kind: "review", left: 0 };
}
// 今日出す新しい語の数（final では使わない）。total＝範囲の語数
// 本人決定（2026-10-10）：やり残しは翌日に積む。今日までに出し終える数（範囲×経過日数÷新しい語を出す日数）からやった語を引く
// （前の版は 残り÷残り日数 で、やり残しが後ろの日に薄く散っていた）
function wcFreshCount(unseen, phase, total) {
  if (phase.kind !== "intro") return unseen;
  if (!phase.intro || total == null) return Math.ceil(unseen / Math.max(1, phase.left));
  var k = phase.intro - phase.left + 1;                                     // 新しい語を出す日の何日目か
  return Math.max(0, Math.min(unseen, Math.ceil(total * k / phase.intro) - (total - unseen)));
}
// 1 周の対象の語（lap に合わせて）。rows＝期間の全語、t＝テスト範囲
function wcLapBook(bk, lap) {
  if (lap !== "prev") return bk;
  var inT = {};
  (bk.t || []).forEach(function (r) { inT[r] = 1; });
  var prev = bk.rows.filter(function (r) { return !inT[r]; });
  return { rows: prev, t: prev };
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
//   渡した日から今日までの足す日（rest の曜日＝日曜を除く）の数×daily 語（テスト範囲の中で）。休んだ日の分は次の足す日に回る。
//   rest の曜日は新しい語を出さない（復習だけ）。前週の範囲でまだやっていない語は先に全部出す。返すのは今日出す新しい語の行番号（番号順）
// rest には曜日の数字のほかに日付（"2026-10-13" の形）も入る。その日も新しい語を足さない（2026-10-20 渡辺：修学旅行の 4 日）
function wcRest(bk, day) { var r = bk.rest || []; return r.indexOf(new Date(day + "T00:00:00").getDay()) >= 0 || r.indexOf(day) >= 0; }
// 但し書き「（土日は復習だけ）」（2026-09-26 宮本で日曜だけでなく複数曜日に）
function restLabel(rest) {
  var s = (rest || []).filter(function (i) { return typeof i === "number"; }).sort();   // 日付の休みは但し書きに出さない
  if (!s.length) return "";
  if (s.join() === "0,6") return "（土日は復習だけ）";
  return "（" + s.map(function (i) { return "日月火水木金土".charAt(i) + "曜"; }).join("・") + "は復習だけ）";
}
// 新しい語を足す日か：渡した日の翌日〜テストの前々日、休みの曜日・日付を除く
function wcAddDay(bk, handout, test, day) {
  return day > handout && wcDays(day, test) >= 2 && !wcRest(bk, day);
}
// 渡した日の翌日〜day（含む）のうち新しい語を足す日の数。day を省くとテストの前々日まで（期間全体）
function wcNewDays(bk, handout, test, day) {
  var n = 0, end = day || test;
  for (var i = 1; i <= wcDays(handout, end); i++) {
    var d = new Date(handout + "T00:00:00"); d.setDate(d.getDate() + i);
    if (wcAddDay(bk, handout, test, wcIso(d))) n++;
  }
  return n;
}
// 今日までに足し終える新しい語の数（テスト範囲 tn 語のうち）。規定量×足す日、範囲と合わなければ範囲÷足す日で割る
function wcDailyGoal(bk, handout, test, day, tn) {
  var all = wcNewDays(bk, handout, test), k = wcNewDays(bk, handout, test, day);
  if (!all) return day > handout ? tn : 0;
  var per = bk.daily && bk.daily * all >= tn ? bk.daily : tn / all;
  return Math.min(tn, Math.ceil(per * k));
}
// carry（2026-10-24 渡辺）：休みの日も積み残し（前の範囲のやっていない語・もう出した日の分のやり残し）は出す。新しく足すのは休みの日以外だけ
//   （前の版は休みの日に何も出さず、金曜の約 400 語が土曜に消えて見えた）
function wcDailyRows(bk, fsrs, handout, today, test) {
  if (today <= handout || wcDays(today, test) <= 1) return [];           // テストの日・前日は新しい語を足さない
  if (wcRest(bk, today) && !bk.carry) return [];
  var t = bk.t || bk.rows, inT = {}, seenT = 0;
  t.forEach(function (r) { inT[r] = 1; if (fsrs[r]) seenT++; });
  var room = Math.max(0, wcDailyGoal(bk, handout, test, today, t.length) - seenT);
  var old = bk.rows.filter(function (r) { return !inT[r] && !fsrs[r]; });
  return old.concat(t.filter(function (r) { return !fsrs[r]; }).slice(0, room));
}

function wcLeft(snap, today) {
  today = today || wcToday();
  var fsrs = snap.fsrs || {}, out = [], phase = wcPhase(snap.handout, snap.test, today);
  (snap.books || []).forEach(function (bk) {
    var n, inFin = null;
    if (phase.kind === "final") {                // 2026-10-25〜 毎日足す単語帳も前日・テストの日は 1 周（新しい語は足さない）
      var fin = wcFinalRows(wcLapBook(bk, phase.lap), fsrs, today);
      inFin = {};
      fin.forEach(function (r) { inFin[r] = 1; });
      var due = 0;
      Object.keys(fsrs).forEach(function (row) { if (snap.bookOf[row] === bk.b && !inFin[row] && wcDue(fsrs[row], today)) due++; });
      n = fin.length + Math.min(due, WC_FINAL_REVIEW_MAX);
    } else {
      var d = 0;
      Object.keys(fsrs).forEach(function (row) { if (snap.bookOf[row] === bk.b && wcDue(fsrs[row], today)) d++; });
      var plan = (snap.plans || {})[bk.b], fresh;
      if (plan && plan.date === today) fresh = plan.rows.filter(function (r) { return !fsrs[r]; }).length;
      else if (bk.daily && snap.handout) fresh = wcDailyRows(bk, fsrs, snap.handout, today, snap.test).length;
      else fresh = wcFreshCount(bk.rows.filter(function (r) { return !fsrs[r]; }).length, phase, bk.rows.length);
      n = Math.min(d, WC_REVIEW_MAX) + fresh;
    }
    // 学習ステップの途中で終わった語（抜けるまで残る。前の日のぶんも翌日に積む。期限の語・前日の 1 周と重なる語は上で数えた）
    n += (snap.pend || []).filter(function (r) {
      var st = fsrs[r];
      return snap.bookOf[r] === bk.b && !(st && wcDue(st, today)) && !(inFin && inFin[r]);
    }).length;
    out.push({ b: bk.b, label: bk.label, n: n });
  });
  return out;
}
// 通知の文面：「今日の残り　英 42 語・古文 12 語」
function wcText(left) {
  var parts = left.filter(function (x) { return x.n > 0; }).map(function (x) { return (x.b === "k" ? "古文 " : "英 ") + x.n + " 語"; });
  return parts.length ? "今日の残り　" + parts.join("・") : "";
}
