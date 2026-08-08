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
