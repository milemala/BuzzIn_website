// 后台批量导入【气泡 NOW】脚本
//
// 运行方式：
//
//	go run ./scripts/import/now -f scripts/import/now/sample.json
//
// 或编译后运行：
//
//	go build -o bin/import-now ./scripts/import/now
//	./bin/import-now -base http://localhost:80 -f nows.json
//
// 认证：
//   - 直接传 token：-token 'xxxx'（或填下面的 defaultToken 变量）
//   - 留空 token 时，用 -user / -pass 自动登录 /internal/auth/login 换取 token
//
// 注意：每个气泡必须挂在一个【已存在】的用户 user_id 上（发布者）。
// 若需要先建用户，可调用后台 POST /internal/users（本脚本不含，按需扩展）。
//
// 只依赖 Go 标准库，可在任意机器上 go run。
//
// ============================================================
// 导入须知（重要，务必先读）
// ============================================================
//
//  1. 必须有发布者 user_id（已存在的用户），否则后端报 user not found。
//     需要先批量建用户的话，可调 POST /internal/users（phone 必填），本脚本未含。
//
//  2. now_type 必填：1 动态 / 2 即刻邀约 / 3 预约（0 非法）。
//
//  3. 宽高必须发：upload 返回的 width/height 必须随 now_medias 一起回传。
//     后台创建只把 now_medias 数组【原样存库】，App 端读取(详情/列表卡/地图卡)也
//     只信存库的 JSON，不会按 media_id 回补宽高；不发就永久存成 0×0，比例渲染错乱。
//     本脚本已自动带上 upload 返回的宽高（见 uploadMedia / mediaItem）。
//     注意：视频宽高由 OSS 截帧识别，偶发为 0，必要时在输入数据里手填覆盖。
//     另：now_medias 里【第一张图片】会被后端自动取为封面 now_cover。
//
//  4. POI（location_poi_id）—— 关键概念：
//     - 它是【外部地图(高德/腾讯等)的 POI 标识】，后端不会生成，需要数据方提供。
//     - 对“创建气泡”本身是【可选】的，留空也能建成功。
//     - 但它是【气泡挂到商户的唯一关联键】：气泡的 location_poi_id 精确匹配某商户的
//       address_poi_id（SQL: WHERE address_poi_id = ?）才会关联该商户；
//       本接口【没有 merchant_id 字段】。想让气泡显示在对应商户下，就让气泡和
//       该商户【使用同一个 poi 值】（与建商户脚本里填的 address_poi_id 一致）。
//     - 切勿用空字符串去匹配（会误挂到第一条 poi 为空的商户）；本脚本仅在非空时发送。
//     - 经纬度 location_latitude/longitude 与 POI 另算：用于 geohash/距离/地图，建议都提供。
//
//  5. 图片安审：upload 对图片会同步过内容安审，不过会直接报“文件未通过安审”。
//
//  6. 时间字段格式："2006-01-02 15:04:05"（本地时区），均可选。
//
//  7. 鉴权：-token 直接给 Bearer token；或留空用 -user/-pass 登录换取；
//     后端也支持 USER: <admin_id> 头免登录（本脚本用 Bearer 方式）。
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
	flagFile  = flag.String("f", "nows.json", "输入数据 JSON 文件路径")
	flagOut   = flag.String("out", "nows.result.json", "结果输出 JSON 文件路径")
	flagDedup = flag.Bool("dedup", true, "建之前按 user_id+标题 查重，命中则跳过（避免重复气泡）")
)

const apiPrefix = "/internal"

// httpTimeout 给所有请求加超时，避免后端无响应时整批卡死
const httpTimeout = 60 * time.Second

// maxContentLen：now_content 的 binding 上限（max=2000），超出会 400，脚本侧先截断
const maxContentLen = 2000

// defaultExpireDays：输入未提供 expired_at 时，自动把过期时间设为「现在 + N 天」。
// 原因：后端默认过期是“次日凌晨 4:00”，导入的气泡第二天早上就会被 cron 置为已过期、
// 从地图消失。这里兜底成远期，避免静默失效。数据方最好仍自行给准确值。
const defaultExpireDays = 30

// timeLayout：后端接受的时间格式（按服务器进程本地时区解析，见 README 时区说明）。
const timeLayout = "2006-01-02 15:04:05"

// maxTitleLen：now_title 的 DB 列上限（bi_user_now.now_title size:128）。
// 接口 binding 写的是 max=255，会放过去但入库静默截断到 128，所以脚本侧先截断。
const maxTitleLen = 128

// ============================================================
// 输入 / 输出数据结构
// ============================================================

// NowInput 一条爬虫抓取的气泡数据
type NowInput struct {
	UserID     string  `json:"user_id"`     // 发布者用户 id（必填，必须已存在）
	NowTitle   string  `json:"now_title"`   // 标题
	NowContent string  `json:"now_content"` // 内容
	NowType    int     `json:"now_type"`    // 必填：1 动态 / 2 即刻邀约 / 3 预约
	NowStatus  int     `json:"now_status"`  // 1 正常（默认）/ -1 屏蔽
	NowWeight  float64 `json:"now_weight"`  // 权重（默认 100）

	// 媒体：http(s) 链接或本地路径，按顺序。第一张图片会被后端自动取为封面。
	Images []string `json:"images"`
	Videos []string `json:"videos"` // 视频（可选）；上传后 media_type=2

	// 位置（可选）。location_poi_id 需数据方提供，命中商户 address_poi_id 时自动关联商户；
	// 想挂到某商户名下就与该商户填同一个 poi 值（见文件头“导入须知”第4条）。
	LocationPoiID   string   `json:"location_poi_id"`
	LocationName    string   `json:"location_name"`
	LocationAddress string   `json:"location_address"`
	LocationLat     *float64 `json:"location_latitude"`
	LocationLng     *float64 `json:"location_longitude"`

	// 时间（可选），格式 "2006-01-02 15:04:05"
	StartAt   string `json:"start_at"`
	CreatedAt string `json:"created_at"`
	ExpiredAt string `json:"expired_at"`
}

// nowResult 单条导入结果
type nowResult struct {
	Title   string `json:"title"`
	NowID   string `json:"now_id,omitempty"`
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
	var inputs []NowInput
	if err := json.Unmarshal(raw, &inputs); err != nil {
		fatal("解析输入 JSON 失败: %v", err)
	}
	fmt.Printf("[input] 共 %d 条气泡待导入\n", len(inputs))

	// 3) 逐条：先上传媒体 → 再创建气泡
	results := make([]nowResult, 0, len(inputs))
	for i, in := range inputs {
		fmt.Printf("\n[%d/%d] %s\n", i+1, len(inputs), in.NowTitle)
		res := nowResult{Title: in.NowTitle}

		if in.UserID == "" {
			res.Error = "缺少 user_id（发布者）"
			results = append(results, res)
			fmt.Println("  ✗", res.Error)
			continue
		}
		if in.NowType < 1 || in.NowType > 3 {
			res.Error = fmt.Sprintf("now_type 非法: %d（应为 1/2/3）", in.NowType)
			results = append(results, res)
			fmt.Println("  ✗", res.Error)
			continue
		}
		// now_title 的 DB 列上限是 128 字符（注意：接口 binding 写的是 255，会放过去再静默截断）
		if n := len([]rune(in.NowTitle)); n > maxTitleLen {
			fmt.Printf("  ! now_title %d 字超过 DB 上限 %d，自动截断\n", n, maxTitleLen)
			in.NowTitle = string([]rune(in.NowTitle)[:maxTitleLen])
		}
		// now_content 的 binding 上限 2000（超出会 400），rune 安全截断
		if n := len([]rune(in.NowContent)); n > maxContentLen {
			fmt.Printf("  ! now_content %d 字超过上限 %d，自动截断\n", n, maxContentLen)
			in.NowContent = string([]rune(in.NowContent)[:maxContentLen])
		}

		// 查重（按 发布者+标题）
		if *flagDedup && in.NowTitle != "" {
			if nid, err := c.findNow(in.UserID, in.NowTitle); err != nil {
				res.Error = fmt.Sprintf("查重失败: %v", err)
				results = append(results, res)
				fmt.Println("  ✗", res.Error)
				continue
			} else if nid != "" {
				res.NowID = nid
				res.Skipped = true
				results = append(results, res)
				fmt.Printf("  ↷ 已存在，跳过 now_id=%s\n", nid)
				continue
			}
		}

		// 3.1 上传媒体（图片在前、视频在后，保持顺序；封面取第一张图片）
		medias := make([]mediaItem, 0, len(in.Images)+len(in.Videos))
		uploadErr := ""
		for _, src := range append(append([]string{}, in.Images...), in.Videos...) {
			m, err := c.uploadMedia(src)
			if err != nil {
				uploadErr = fmt.Sprintf("上传媒体失败 %s: %v", src, err)
				break
			}
			medias = append(medias, m)
			fmt.Printf("  ✓ 媒体 -> %s (%dx%d type=%d)\n", m.MediaURL, m.Width, m.Height, m.MediaType)
		}
		if uploadErr != "" {
			res.Error = uploadErr
			results = append(results, res)
			fmt.Println("  ✗", res.Error)
			continue
		}

		// 3.2 创建气泡
		payload := map[string]any{
			"user_id":     in.UserID,
			"now_title":   in.NowTitle,
			"now_content": in.NowContent,
			"now_type":    in.NowType,
		}
		if in.NowStatus != 0 {
			payload["now_status"] = in.NowStatus
		}
		if in.NowWeight != 0 {
			payload["now_weight"] = in.NowWeight
		}
		if len(medias) > 0 {
			payload["now_medias"] = medias
		}
		if in.LocationPoiID != "" {
			payload["location_poi_id"] = in.LocationPoiID
		}
		if in.LocationName != "" {
			payload["location_name"] = in.LocationName
		}
		if in.LocationAddress != "" {
			payload["location_address"] = in.LocationAddress
		}
		if in.LocationLat != nil {
			payload["location_latitude"] = *in.LocationLat
		}
		if in.LocationLng != nil {
			payload["location_longitude"] = *in.LocationLng
		}
		if in.StartAt != "" {
			payload["start_at"] = in.StartAt
		}
		if in.CreatedAt != "" {
			payload["created_at"] = in.CreatedAt
		}
		if in.ExpiredAt != "" {
			payload["expired_at"] = in.ExpiredAt
		} else {
			// 兜底：避免用后端默认的“次日 4:00”过期导致气泡很快从地图消失
			payload["expired_at"] = time.Now().AddDate(0, 0, defaultExpireDays).Format(timeLayout)
		}

		var created struct {
			NowID string `json:"now_id"`
		}
		if err := c.postJSON("/nows", payload, &created); err != nil {
			res.Error = fmt.Sprintf("创建气泡失败: %v", err)
			results = append(results, res)
			fmt.Println("  ✗", res.Error)
			continue
		}
		res.NowID = created.NowID
		results = append(results, res)
		fmt.Printf("  ★ 气泡创建成功 now_id=%s\n", created.NowID)
	}

	// 4) 输出结果
	out, _ := json.MarshalIndent(results, "", "  ")
	_ = os.WriteFile(*flagOut, out, 0o644)
	created, skipped := 0, 0
	for _, r := range results {
		if r.Skipped {
			skipped++
		} else if r.NowID != "" {
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

// findNow 按 发布者+标题 查重：POST /internal/nows/list keyword=title & user_identifier=userID，
// 再精确比对 (user_id, now_title)。命中返回 now_id。
func (c *client) findNow(userID, title string) (string, error) {
	var out struct {
		List []struct {
			NowID    string `json:"now_id"`
			NowTitle string `json:"now_title"`
			User     *struct {
				UserID string `json:"user_id"`
			} `json:"user"`
		} `json:"list"`
	}
	body := map[string]any{"page": 1, "size": 100, "keyword": title, "user_identifier": userID}
	if err := c.postJSON("/nows/list", body, &out); err != nil {
		return "", err
	}
	for _, n := range out.List {
		if n.NowTitle == title && n.User != nil && n.User.UserID == userID {
			return n.NowID, nil
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
