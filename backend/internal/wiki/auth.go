// Package wiki は MediaWiki のアカウントで本人確認を行う。
//
// 共有パスワード1本だと全員が同じ利用者として扱われ、チャット履歴を
// 分けられない。Wikiのアカウントをそのまま使えば、
//   - 新しいパスワードを配らなくてよい
//   - 部員でなくなればWiki側でアカウントを止めるだけで締め出せる
//   - 利用者名が取れるので履歴を個人ごとに分けられる
//
// ⚠️ この方式はアプリがWikiのパスワードを一度受け取る。したがって
//   - パスワードは保存しない。ログにも出さない。認証に使って捨てる
//   - Cookieに載せるのは利用者名と有効期限だけ
//   - 利用者が望むなら 特別:BotPasswords で発行した
//     「本アカウント名@ボット名」形式のものを使える（本パスワードを渡さずに済む）
package wiki

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"time"
)

var (
	ErrBadCredentials = errors.New("利用者名またはパスワードが違います")
	ErrUnavailable    = errors.New("Wikiに接続できません")
)

type Authenticator struct {
	endpoint string
	timeout  time.Duration
}

func New(apiEndpoint string) *Authenticator {
	return &Authenticator{endpoint: apiEndpoint, timeout: 20 * time.Second}
}

// Login は利用者名とパスワードをWikiで検証し、正規化された利用者名を返す。
// パスワードはこの関数の外に出ない。
func (a *Authenticator) Login(ctx context.Context, username, password string) (string, error) {
	// ログイントークンの取得とログインは同一セッションで行う必要がある
	jar, err := cookiejar.New(nil)
	if err != nil {
		return "", err
	}
	client := &http.Client{Jar: jar, Timeout: a.timeout}

	token, err := a.loginToken(ctx, client)
	if err != nil {
		return "", err
	}

	// 「名前@ボット名」は BotPasswords。旧来の action=login でしか通らない。
	// 通常のアカウントは現行の action=clientlogin を使う
	if strings.Contains(username, "@") {
		return a.legacyLogin(ctx, client, username, password, token)
	}
	return a.clientLogin(ctx, client, username, password, token)
}

func (a *Authenticator) post(ctx context.Context, client *http.Client, form url.Values, out any) error {
	form.Set("format", "json")
	form.Set("formatversion", "2")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.endpoint,
		strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%w: %s", ErrUnavailable, resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (a *Authenticator) loginToken(ctx context.Context, client *http.Client) (string, error) {
	var out struct {
		Query struct {
			Tokens struct {
				LoginToken string `json:"logintoken"`
			} `json:"tokens"`
		} `json:"query"`
	}
	form := url.Values{"action": {"query"}, "meta": {"tokens"}, "type": {"login"}}
	if err := a.post(ctx, client, form, &out); err != nil {
		return "", err
	}
	if out.Query.Tokens.LoginToken == "" {
		return "", ErrUnavailable
	}
	return out.Query.Tokens.LoginToken, nil
}

func (a *Authenticator) clientLogin(ctx context.Context, client *http.Client,
	username, password, token string) (string, error) {
	var out struct {
		ClientLogin struct {
			Status   string `json:"status"`
			Username string `json:"username"`
			Message  string `json:"message"`
		} `json:"clientlogin"`
	}
	form := url.Values{
		"action":         {"clientlogin"},
		"username":       {username},
		"password":       {password},
		"logintoken":     {token},
		"loginreturnurl": {"https://example.org/"}, // 使われないが必須
	}
	if err := a.post(ctx, client, form, &out); err != nil {
		return "", err
	}
	if out.ClientLogin.Status != "PASS" {
		return "", ErrBadCredentials
	}
	name := out.ClientLogin.Username
	if name == "" {
		name = username
	}
	return name, nil
}

func (a *Authenticator) legacyLogin(ctx context.Context, client *http.Client,
	username, password, token string) (string, error) {
	var out struct {
		Login struct {
			Result     string `json:"result"`
			LgUsername string `json:"lgusername"`
		} `json:"login"`
	}
	form := url.Values{
		"action":     {"login"},
		"lgname":     {username},
		"lgpassword": {password},
		"lgtoken":    {token},
	}
	if err := a.post(ctx, client, form, &out); err != nil {
		return "", err
	}
	if out.Login.Result != "Success" {
		return "", ErrBadCredentials
	}
	name := out.Login.LgUsername
	if name == "" {
		// BotPasswords の「本名@ボット名」から本名だけ取る
		name, _, _ = strings.Cut(username, "@")
	}
	return name, nil
}
