// Package feedbackmail は、保存済みフィードバックのメール通知を担当する。
package feedbackmail

import (
	"context"
	"crypto/tls"
	"fmt"
	"mime"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"

	"github.com/97kuek/wasa-chat/backend/internal/state"
)

const (
	defaultSMTPPort    = 587
	answerPreviewRunes = 2_000
)

type Config struct {
	Host       string
	Port       int
	Username   string
	Password   string
	From       string
	Recipients []string
}

type SMTP struct {
	cfg  Config
	from mail.Address
	to   []mail.Address
}

func New(cfg Config) (*SMTP, error) {
	cfg.Host = strings.TrimSpace(cfg.Host)
	cfg.From = strings.TrimSpace(cfg.From)
	if cfg.Port == 0 {
		cfg.Port = defaultSMTPPort
	}
	if cfg.Host == "" || cfg.Port < 1 || cfg.Port > 65_535 {
		return nil, fmt.Errorf("SMTP_HOST または SMTP_PORT が不正です")
	}
	if (cfg.Username == "") != (cfg.Password == "") {
		return nil, fmt.Errorf("SMTP_USERNAME と SMTP_PASSWORD は両方設定してください")
	}
	from, err := mail.ParseAddress(cfg.From)
	if err != nil {
		return nil, fmt.Errorf("SMTP_FROM が不正です: %w", err)
	}
	if len(cfg.Recipients) == 0 {
		return nil, fmt.Errorf("FEEDBACK_EMAIL_TO が未設定です")
	}
	to := make([]mail.Address, 0, len(cfg.Recipients))
	for _, raw := range cfg.Recipients {
		address, err := mail.ParseAddress(strings.TrimSpace(raw))
		if err != nil {
			return nil, fmt.Errorf("FEEDBACK_EMAIL_TO が不正です: %w", err)
		}
		to = append(to, *address)
	}
	return &SMTP{cfg: cfg, from: *from, to: to}, nil
}

func (s *SMTP) Notify(ctx context.Context, item state.Feedback) error {
	address := net.JoinHostPort(s.cfg.Host, strconv.Itoa(s.cfg.Port))
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", address)
	if err != nil {
		return fmt.Errorf("SMTPへ接続: %w", err)
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}

	client, err := smtp.NewClient(conn, s.cfg.Host)
	if err != nil {
		return fmt.Errorf("SMTP通信を開始: %w", err)
	}
	defer client.Close()
	if ok, _ := client.Extension("STARTTLS"); !ok {
		return fmt.Errorf("SMTPサーバーがSTARTTLSに対応していません")
	}
	if err := client.StartTLS(&tls.Config{ServerName: s.cfg.Host, MinVersion: tls.VersionTLS12}); err != nil {
		return fmt.Errorf("SMTP通信を暗号化: %w", err)
	}
	if s.cfg.Username != "" {
		if err := client.Auth(smtp.PlainAuth("", s.cfg.Username, s.cfg.Password, s.cfg.Host)); err != nil {
			return fmt.Errorf("SMTPへ認証: %w", err)
		}
	}
	if err := client.Mail(s.from.Address); err != nil {
		return fmt.Errorf("送信元を設定: %w", err)
	}
	for _, recipient := range s.to {
		if err := client.Rcpt(recipient.Address); err != nil {
			return fmt.Errorf("宛先を設定: %w", err)
		}
	}
	writer, err := client.Data()
	if err != nil {
		return fmt.Errorf("本文の送信を開始: %w", err)
	}
	if _, err := writer.Write([]byte(s.message(item))); err != nil {
		_ = writer.Close()
		return fmt.Errorf("本文を送信: %w", err)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("本文を確定: %w", err)
	}
	if err := client.Quit(); err != nil {
		return fmt.Errorf("SMTP通信を終了: %w", err)
	}
	return nil
}

func (s *SMTP) message(item state.Feedback) string {
	subject := "WASA Chatへの改善報告"
	if item.Kind == "answer" {
		subject = "WASA Chatの回答評価"
	}
	recipients := make([]string, 0, len(s.to))
	for _, recipient := range s.to {
		recipients = append(recipients, recipient.String())
	}
	body := feedbackBody(item)
	return strings.Join([]string{
		"From: " + s.from.String(),
		"To: " + strings.Join(recipients, ", "),
		"Subject: " + mime.QEncoding.Encode("UTF-8", subject),
		"Date: " + time.Now().UTC().Format(time.RFC1123Z),
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: 8bit",
		"",
		body,
	}, "\r\n")
}

func clip(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
}

func feedbackBody(item state.Feedback) string {
	lines := []string{
		"種類: " + item.Kind,
		"評価: " + item.Rating,
		"理由: " + strings.Join(item.Reasons, ", "),
		"補足: " + item.Comment,
		"画面: " + item.Page,
		"アシスタント: " + item.AssistantName,
		"回答モード: " + item.ResponseMode + " → " + item.ResolvedMode,
		"送信日時: " + item.SubmittedAt,
	}
	if item.Question != "" {
		lines = append(lines, "", "質問:", item.Question)
	}
	if item.Answer != "" {
		lines = append(lines, "", "回答（先頭部分）:", clip(item.Answer, answerPreviewRunes))
	}
	if len(item.Sources) > 0 {
		lines = append(lines, "", "参照資料:")
		for _, source := range item.Sources {
			lines = append(lines, "- "+source.Title+" "+source.URL)
		}
	}
	// ReporterKey は匿名化した内部キーであり、管理者への通知にも不要。
	return strings.Join(lines, "\r\n") + "\r\n"
}
