// 后台批量导入【用户】脚本（气泡的发布者）
//
// 运行方式：
//
//	go run ./scripts/import/user -f scripts/import/user/sample.json
//
// 或编译后运行：
//
//	go build -o bin/import-user ./scripts/import/user
//	./bin/import-user -base http://localhost:80 -f users.json
//
// 认证：
//   - 直接传 token：-token 'xxxx'（或填下面的 defaultToken 变量）
//   - 留空 token 时，用 -user / -pass 自动登录 /internal/auth/login 换取 token
//
// ============================================================
// 导入须知（重要，务必先读）
// ============================================================
//
//  1. phone 必填，且【全局唯一】：手机号写进 bi_auth(auth_type,auth_id) 唯一索引，
//     重复手机号再建会直接撞唯一键报错。所以本脚本默认开启【按手机号查重】(-dedup=true)：
//     建之前先查 /internal/users/list，命中同号则跳过并复用已存在的 user_id。
//
//  2. 用户是气泡的发布者：建好用户拿到 user_id 后，再用它去发气泡（now/main.go 的 user_id）。
//     一条龙顺序：查重 → 建用户(本脚本) → 建商户 → 建气泡。
//
//  3. avatar / 相册：avatar_image 与 images 支持 http(s) 链接或本地路径，会先推到 /internal/upload，
//     拿到 media 信息后填入（avatar 用返回的 URL；images 作为 medias，带宽高）。
//     图片要过内容安审，过不了会整条失败。
//
//  4. birthday 是【Unix 秒】（不是毫秒）；gender：0未知/1男/2女；status：0 默认正常、-1 禁用。
//
//  5. 鉴权：-token 直接给 Bearer token；或留空用 -user/-pass 登录换取。
//
// 只依赖 Go 标准库，可在任意机器上 go run。
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ============================================================
// 配置（token 默认空字符串，按需求保留）
// ============================================================

var defaultToken = "" // 后台登录返回的 Bearer token，先留空

var (
	flagBase  = flag.String("base", env("BUZZ_API_BASE", "http://localhost:80"), "后端地址，例如 http://localhost:80 或 http://test-go-api.nowmap.cn")
	flagToken = flag.String("token", defaultToken, "后台 Bearer token（留空则用 -user/-pass 登录）")
	flagUser  = flag.String("user", env("BUZZ_ADMIN_USER", ""), "后台用户名（token 为空时用于登录）")
	flagPass  = flag.String("pass", env("BUZZ_ADMIN_PASS", ""), "后台密码（token 为空时用于登录）")
	flagFile  = flag.String("f", "users.json", "输入数据 JSON 文件路径")
	flagOut   = flag.String("out", "users.result.json", "结果输出 JSON 文件路径")
	flagDedup = flag.Bool("dedup", true, "建之前按手机号查重，命中则跳过（避免唯一键冲突）")
)

const apiPrefix = "/internal"

// httpTimeout 给所有请求加超时，避免后端无响应时整批卡死
const httpTimeout = 60 * time.Second

const (
	maxPhoneLen    = 32 // bi_users.phone size:32
	maxNicknameLen = 64 // bi_users.nickname size:64
)

// ============================================================
// 输入 / 输出数据结构
// ============================================================

// UserInput 一条爬虫抓取的用户数据
type UserInput struct {
	Phone       string   `json:"phone"`        // 必填，全局唯一
	Nickname    string   `json:"nickname"`     // 昵称
	AvatarImage string   `json:"avatar_image"` // 头像图：http(s) 链接或本地路径，可空
	Gender      int      `json:"gender"`       // 0未知 / 1男 / 2女
	Description string   `json:"description"`  // 个人简介
	Birthday    *int64   `json:"birthday"`     // 生日 Unix 秒，可空
	Status      int      `json:"status"`       // 0默认正常 / -1禁用
	Images      []string `json:"images"`       // 用户相册：http(s) 链接或本地路径，可空
}

// userResult 单条导入结果
type userResult struct {
	Phone   string `json:"phone"`
	UserID  string `json:"user_id,omitempty"`
	Skipped bool   `json:"skipped,omitempty"` // 已存在被跳过
	Error   string `json:"error,omitempty"`
}

// mediaItem 创建接口需要的媒体结构（与后端 MediaItemDTO 对齐）
type mediaItem struct {
	MediaID   string `json:"media_id"`
	MediaURL  string `json:"media_url"`
	MediaType int    `json:"media_type"` // 1 图片 2 视频
	Width     int    `json:"width,omitempty"`
	Height    int    `json:"height,omitempty"`
}

func main() {
	flag.Parse()
	c := &client{base: strings.TrimRight(*flagBase, "/"), token: *flagToken, hc: http.Client{Timeout: httpTimeout}}

	// 1) 准备 token
	if c.token == "" {
		if *flagUser == "" || *flagPass == "" {
			fatal("token 为空，且未提供 -user/-pass 用于登录")
		}
		tok, err := c.login(*flagUser, *flagPass)
		if err != nil {
			fatal("登录失败: %v", err)
		}
		c.token = tok
		fmt.Println("[auth] 登录成功，已获取 token")
	}

	// 2) 读取输入数据
	raw, err := os.ReadFile(*flagFile)
	if err != nil {
		fatal("读取输入文件失败: %v", err)
	}
	var inputs []UserInput
	if err := json.Unmarshal(raw, &inputs); err != nil {
		fatal("解析输入 JSON 失败: %v", err)
	}
	fmt.Printf("[input] 共 %d 条用户待导入（dedup=%v）\n", len(inputs), *flagDedup)

	// 3) 逐条：查重 → 上传头像/相册 → 建用户
	results := make([]userResult, 0, len(inputs))
	for i, in := range inputs {
		fmt.Printf("\n[%d/%d] %s %s\n", i+1, len(inputs), in.Phone, in.Nickname)
		res := userResult{Phone: in.Phone}

		if in.Phone == "" {
			res.Error = "缺少 phone（必填且唯一）"
			results = append(results, res)
			fmt.Println("  ✗", res.Error)
			continue
		}
		if len(in.Phone) > maxPhoneLen {
			res.Error = fmt.Sprintf("phone 超过 DB 上限 %d 字节（当前 %d）", maxPhoneLen, len(in.Phone))
			results = append(results, res)
			fmt.Println("  ✗", res.Error)
			continue
		}
		// nickname 超过 DB 上限会被静默截断，这里 rune 安全截断并告警
		if n := len([]rune(in.Nickname)); n > maxNicknameLen {
			fmt.Printf("  ! nickname %d 字超过 DB 上限 %d，自动截断\n", n, maxNicknameLen)
			in.Nickname = string([]rune(in.Nickname)[:maxNicknameLen])
		}

		// 3.1 查重（按手机号）
		if *flagDedup {
			if uid, err := c.findUserByPhone(in.Phone); err != nil {
				res.Error = fmt.Sprintf("查重失败: %v", err)
				results = append(results, res)
				fmt.Println("  ✗", res.Error)
				continue
			} else if uid != "" {
				res.UserID = uid
				res.Skipped = true
				results = append(results, res)
				fmt.Printf("  ↷ 已存在，跳过 user_id=%s\n", uid)
				continue
			}
		}

		// 3.2 上传头像
		avatarURL := ""
		if in.AvatarImage != "" {
			m, err := c.uploadMedia(in.AvatarImage)
			if err != nil {
				res.Error = fmt.Sprintf("上传头像失败: %v", err)
				results = append(results, res)
				fmt.Println("  ✗", res.Error)
				continue
			}
			avatarURL = m.MediaURL
			fmt.Printf("  ✓ avatar -> %s\n", m.MediaURL)
		}

		// 3.3 上传相册
		medias := make([]mediaItem, 0, len(in.Images))
		uploadErr := ""
		for _, src := range in.Images {
			m, err := c.uploadMedia(src)
			if err != nil {
				uploadErr = fmt.Sprintf("上传图片失败 %s: %v", src, err)
				break
			}
			medias = append(medias, m)
			fmt.Printf("  ✓ 图片 -> %s (%dx%d type=%d)\n", m.MediaURL, m.Width, m.Height, m.MediaType)
		}
		if uploadErr != "" {
			res.Error = uploadErr
			results = append(results, res)
			fmt.Println("  ✗", res.Error)
			continue
		}

		// 3.4 建用户
		payload := map[string]any{
			"phone":       in.Phone,
			"nickname":    in.Nickname,
			"gender":      in.Gender,
			"description": in.Description,
			"status":      in.Status,
		}
		if avatarURL != "" {
			payload["avatar"] = avatarURL
		}
		if len(medias) > 0 {
			payload["medias"] = medias
		}
		if in.Birthday != nil {
			payload["birthday"] = *in.Birthday
		}

		var created struct {
			UserID string `json:"user_id"`
		}
		if err := c.postJSON("/users", payload, &created); err != nil {
			res.Error = fmt.Sprintf("创建用户失败: %v", err)
			results = append(results, res)
			fmt.Println("  ✗", res.Error)
			continue
		}
		res.UserID = created.UserID
		results = append(results, res)
		fmt.Printf("  ★ 用户创建成功 user_id=%s\n", created.UserID)
	}

	// 4) 输出结果
	out, _ := json.MarshalIndent(results, "", "  ")
	_ = os.WriteFile(*flagOut, out, 0o644)
	created, skipped := 0, 0
	for _, r := range results {
		if r.Skipped {
			skipped++
		} else if r.UserID != "" {
			created++
		}
	}
	fmt.Printf("\n完成：新建 %d | 跳过(已存在) %d | 共 %d，结果已写入 %s\n", created, skipped, len(results), *flagOut)
}

// ============================================================
// HTTP 客户端（仅标准库）
// ============================================================

type client struct {
	base  string
	token string
	hc    http.Client
}

// apiEnvelope 统一响应包：{code, message, data}
type apiEnvelope struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

// login 用账号密码换取 token：POST /internal/auth/login
func (c *client) login(user, pass string) (string, error) {
	var out struct {
		Token string `json:"token"`
	}
	body := map[string]string{"username": user, "password": pass}
	if err := c.postJSON("/auth/login", body, &out); err != nil {
		return "", err
	}
	if out.Token == "" {
		return "", fmt.Errorf("登录响应未返回 token")
	}
	return out.Token, nil
}

// findUserByPhone 按手机号查重：POST /internal/users/list，keyword=phone，再精确比对
// 返回已存在用户的 user_id；不存在返回空字符串。
func (c *client) findUserByPhone(phone string) (string, error) {
	var out struct {
		List []struct {
			UserID string `json:"user_id"`
			Phone  string `json:"phone"`
		} `json:"list"`
	}
	body := map[string]any{"page": 1, "size": 200, "keyword": phone}
	if err := c.postJSON("/users/list", body, &out); err != nil {
		return "", err
	}
	for _, u := range out.List {
		if u.Phone == phone { // keyword 是模糊匹配，这里做精确比对
			return u.UserID, nil
		}
	}
	return "", nil
}

// postJSON 发送 JSON 请求并把 data 解析到 out
func (c *client) postJSON(path string, body any, out any) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, c.base+apiPrefix+path, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	return c.do(req, out)
}

// uploadMedia 上传一张图片/视频：POST /internal/upload (multipart, 字段名 file)
// src 支持 http(s) 链接或本地文件路径。返回媒体信息（含宽高，后端从 OSS 自动识别）。
func (c *client) uploadMedia(src string) (mediaItem, error) {
	var zero mediaItem

	data, name, err := readSource(src)
	if err != nil {
		return zero, err
	}

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename=%q`, name))
	h.Set("Content-Type", contentTypeFor(name)) // 后端据此判断图片/视频
	part, err := mw.CreatePart(h)
	if err != nil {
		return zero, err
	}
	if _, err := part.Write(data); err != nil {
		return zero, err
	}
	if err := mw.Close(); err != nil {
		return zero, err
	}

	req, err := http.NewRequest(http.MethodPost, c.base+apiPrefix+"/upload", &body)
	if err != nil {
		return zero, err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())

	var out struct {
		MediaID   string `json:"media_id"`
		MediaURL  string `json:"media_url"`
		MediaType int    `json:"media_type"`
		Width     int    `json:"width"`
		Height    int    `json:"height"`
	}
	if err := c.do(req, &out); err != nil {
		return zero, err
	}
	if out.MediaType == 0 {
		out.MediaType = 1
	}
	return mediaItem{
		MediaID:   out.MediaID,
		MediaURL:  out.MediaURL,
		MediaType: out.MediaType,
		Width:     out.Width,
		Height:    out.Height,
	}, nil
}

// do 执行请求，注入鉴权头，校验 envelope.code==0，并解析 data 到 out
func (c *client) do(req *http.Request, out any) error {
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("http %d: %s", resp.StatusCode, truncate(string(raw), 300))
	}
	var env apiEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return fmt.Errorf("响应非 JSON: %s", truncate(string(raw), 300))
	}
	if env.Code != 0 {
		return fmt.Errorf("业务错误 code=%d msg=%s", env.Code, env.Message)
	}
	if out != nil && len(env.Data) > 0 && string(env.Data) != "null" {
		if err := json.Unmarshal(env.Data, out); err != nil {
			return fmt.Errorf("解析 data 失败: %v", err)
		}
	}
	return nil
}

// ============================================================
// 工具函数
// ============================================================

// readSource 读取本地文件或下载远程链接，返回字节和文件名
func readSource(src string) ([]byte, string, error) {
	if strings.HasPrefix(src, "http://") || strings.HasPrefix(src, "https://") {
		hc := http.Client{Timeout: 60 * time.Second}
		resp, err := hc.Get(src)
		if err != nil {
			return nil, "", err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, "", fmt.Errorf("下载失败 http %d", resp.StatusCode)
		}
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, "", err
		}
		name := filepath.Base(strings.SplitN(src, "?", 2)[0])
		if name == "" || name == "." || name == "/" {
			name = "image.jpg"
		}
		return data, name, nil
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return nil, "", err
	}
	return data, filepath.Base(src), nil
}

// contentTypeFor 据扩展名给出 Content-Type，后端用前缀 video/ 区分视频
func contentTypeFor(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".mp4":
		return "video/mp4"
	case ".mov":
		return "video/quicktime"
	case ".avi":
		return "video/x-msvideo"
	case ".mkv":
		return "video/x-matroska"
	case ".webm":
		return "video/webm"
	case ".png":
		return "image/png"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".heic", ".heif":
		return "image/heic"
	default:
		return "image/jpeg"
	}
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func fatal(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "ERROR: "+format+"\n", a...)
	os.Exit(1)
}
