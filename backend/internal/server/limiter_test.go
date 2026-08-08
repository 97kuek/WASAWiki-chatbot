package server

import "testing"

func TestLimiterRefundsFailedQuestion(t *testing.T) {
	limit := newLimiter(3)
	if !limit.take("利用者") || limit.remaining("利用者") != 2 {
		t.Fatal("質問回数を確保できていない")
	}
	limit.refund("利用者")
	if got := limit.remaining("利用者"); got != 3 {
		t.Fatalf("失敗した質問の回数が返却されていない: remaining=%d", got)
	}
	// 二重返却があっても上限を超えない。
	limit.refund("利用者")
	if got := limit.remaining("利用者"); got != 3 {
		t.Fatalf("返却後に上限を超えた: remaining=%d", got)
	}
}

func TestFailedQuestionCookieDoesNotRestoreReservedUsage(t *testing.T) {
	const user = "利用者"
	srv := &Server{
		cfg:   Config{SessionSecret: "テスト用の固定鍵", DailyLimit: 3},
		limit: newLimiter(3),
	}
	srv.limit.restore(user, today(), 1)
	if !srv.limit.take(user) {
		t.Fatal("質問回数を確保できていない")
	}

	// SSE開始時のCookieには、確保中の質問を確定回数として載せない。
	day, used := srv.limit.usage(user)
	token := srv.signUsage(user, day, used)
	if _, got, ok := srv.verifyUsage(token, user); !ok || got != 1 {
		t.Fatalf("確保中の質問がCookieへ保存された: used=%d ok=%v", got, ok)
	}

	srv.limit.refund(user)
	srv.limit.restore(user, day, used)
	if got := srv.limit.remaining(user); got != 2 {
		t.Fatalf("失敗した質問が古いCookieから復活した: remaining=%d", got)
	}
}

func TestLimiterCommitsSuccessfulQuestion(t *testing.T) {
	limit := newLimiter(3)
	if !limit.take("利用者") {
		t.Fatal("質問回数を確保できていない")
	}
	limit.commit("利用者")
	day, used := limit.usage("利用者")
	if day != today() || used != 1 || limit.remaining("利用者") != 2 {
		t.Fatalf("成功した質問を確定できていない: day=%q used=%d remaining=%d",
			day, used, limit.remaining("利用者"))
	}
}

func TestLimiterRestoresUsageWithoutRollingBack(t *testing.T) {
	limit := newLimiter(30)
	limit.restore("利用者", today(), 7)
	if got := limit.remaining("利用者"); got != 23 {
		t.Fatalf("Cookieの使用回数を復元できていない: remaining=%d", got)
	}
	limit.restore("利用者", today(), 3)
	if got := limit.remaining("利用者"); got != 23 {
		t.Fatalf("古いCookieで使用回数が巻き戻った: remaining=%d", got)
	}
	limit.restore("利用者", "2000-01-01", 20)
	if got := limit.remaining("利用者"); got != 23 {
		t.Fatalf("前日のCookieを復元した: remaining=%d", got)
	}
}

func TestUsageCookieIsSignedAndBoundToUser(t *testing.T) {
	srv := &Server{
		cfg:   Config{SessionSecret: "テスト用の固定鍵", DailyLimit: 30},
		limit: newLimiter(30),
	}
	token := srv.signUsage("利用者A", today(), 8)
	day, used, ok := srv.verifyUsage(token, "利用者A")
	if !ok || day != today() || used != 8 {
		t.Fatalf("使用回数Cookieを検証できていない: day=%q used=%d ok=%v", day, used, ok)
	}
	if _, _, ok := srv.verifyUsage(token, "利用者B"); ok {
		t.Fatal("別の利用者の使用回数Cookieを受け入れた")
	}
	if _, _, ok := srv.verifyUsage(token+"x", "利用者A"); ok {
		t.Fatal("改ざんした使用回数Cookieを受け入れた")
	}
}
