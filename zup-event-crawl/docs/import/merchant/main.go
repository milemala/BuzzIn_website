// 后台批量导入【商户】脚本
//
// 运行方式：
//
//	go run ./scripts/import/merchant -f scripts/import/merchant/sample.json
//
// 或编译后运行：
//
//	go build -o bin/import-merchant ./scripts/import/merchant
//	./bin/import-merchant -base http://localhost:80 -f merchants.json
//
// 认证：
//   - 直接传 token：-token 'xxxx'（或填下面的 defaultToken 变量）
//   - 留空 token 时，用 -user / -pass 自动登录 /internal/auth/login 换取 token
//
// 只依赖 Go 标准库，可在任意机器上 go run。
//
// ============================================================
// 导入须知（重要，务必先读）
// ============================================================
//
//  1. 宽高必须发：upload 返回的 width/height 必须随 medias 一起回传。
//     后台创建接口只把 medias 数组【原样存库】，App 端读取也只信存库的 JSON，
//     不会按 media_id 回补宽高；不发就永久存成 0×0，导致图片比例渲染错乱。
//     本脚本已自动带上 upload 返回的宽高（见 uploadMedia / mediaItem）。
//     注意：视频宽高由 OSS 截帧识别，偶发为 0，必要时在输入数据里手填覆盖。
//
//  2. POI（address_poi_id）—— 关键概念：
//     - 它是【外部地图(高德/腾讯等)的 POI 标识】，后端不会生成，需要数据方提供。
//     - 对“创建商户”本身是【可选】的，留空也能建成功。
//     - 但它是【气泡 ↔ 商户 唯一的关联键】：气泡用 location_poi_id 精确匹配
//       商户的 address_poi_id（SQL: WHERE address_poi_id = ?）来挂到商户名下。
//       建气泡可填 now_merchant_id 直挂（推荐），或让气泡 location_poi_id 与该商户
//       address_poi_id 相同（POI 间接挂，见 changeLog2.md）。
//     - 没有真实 POI 时，可自造一个“稳定且每个商户唯一”的字符串
//       （如 crawl_<来源>_<商户key>），只要商户和其气泡保持一致即可。
//     - 切勿用空字符串去匹配：GetByPoiID("") 会命中第一条 poi 为空的商户造成误挂；
//       本脚本只在 poi 非空时才发送，已规避此坑。
//     - 经纬度 longitude/latitude 与 POI 是两回事：用于 geohash/距离/地图，
//       建议商户和气泡都提供真实经纬度。
//
//  3. 图片安审：upload 对图片会同步过内容安审，不过会直接报“文件未通过安审”。
//
//  4. 商户 type 必填，且必须是合法的商户类型 id（取自 /internal/merchant-types/list）。
//
//  5. 鉴权：-token 直接给 Bearer token；或留空用 -user/-pass 登录换取；
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
	flagFile  = flag.String("f", "merchants.json", "输入数据 JSON 文件路径")
	flagOut   = flag.String("out", "merchants.result.json", "结果输出 JSON 文件路径")
	flagDedup = flag.Bool("dedup", true, "建之前按 名称(+poi) 查重，命中则跳过（避免重复商户）")
)

const apiPrefix = "/internal"

// httpTimeout 给所有请求加超时，避免后端无响应时整批卡死
const httpTimeout = 60 * time.Second

// ============================================================
// 输入 / 输出数据结构
// ============================================================

// MerchantInput 一条爬虫抓取的商户数据
type MerchantInput struct {
	Name         string  `json:"name"`           // 商户名
	NameNew      string  `json:"name_new"`       // 新商户名（可选）
	Type         int     `json:"type"`           // 商户类型 id（必填，来自 /internal/merchant-types/list）
	Description  string  `json:"description"`    // 简介
	Longitude    float64 `json:"longitude"`      // 经度（必填）
	Latitude     float64 `json:"latitude"`       // 纬度（必填）
	Address      string  `json:"address"`        // 地址（DB 上限 128 字符）
	AddressPoiID string  `json:"address_poi_id"` // 外部地图 POI id，需数据方提供；想让气泡关联本商户，须与气泡用同一值（见文件头“导入须知”第2条）
	Status       *int    `json:"status"`         // 0待审 1正常 2正常 -1禁用；【留空默认 1】，否则商户在 C 端地图/附近不可见
	Score        float64 `json:"score"`          // 评分
	IsVerified   *int    `json:"is_verified"`    // 是否认证 0/1；【留空默认 1】，否则商户在 C 端地图/附近不可见

	LogoImage      string   `json:"logo_image"`       // 商户 logo 图片：http(s) 链接或本地路径，可空
	Images         []string `json:"images"`           // 商户相册：http(s) 链接或本地路径，按顺序
	OperatorUserID string   `json:"operator_user_id"` // 负责人用户 id（可选）
	AdminIDs       []string `json:"admin_ids"`        // 管理员用户 id 列表（可选）
	Extra          string   `json:"extra"`            // 可选：JSON 字符串，可塞 source_id 做溯源/查重（商户是唯一带 extra 的实体）
}

// intOr 取指针值，nil 时用默认值
func intOr(p *int, def int) int {
	if p == nil {
		return def
	}
	return *p
}

// merchantResult 单条导入结果
type merchantResult struct {
	Name       string `json:"name"`
	MerchantID string `json:"merchant_id,omitempty"`
	Skipped    bool   `json:"skipped,omitempty"` // 已存在被跳过
	Error      string `json:"error,omitempty"`
}

// appendErr 打印错误并把结果记入列表
func appendErr(results []merchantResult, res merchantResult) []merchantResult {
	fmt.Println("  ✗", res.Error)
	return append(results, res)
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

	// 1) 准备 token：没有就登录换取
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
	var inputs []MerchantInput
	if err := json.Unmarshal(raw, &inputs); err != nil {
		fatal("解析输入 JSON 失败: %v", err)
	}
	fmt.Printf("[input] 共 %d 条商户待导入\n", len(inputs))

	// 3) 逐条：先上传图片拿到媒体信息 → 再创建商户
	results := make([]merchantResult, 0, len(inputs))
	for i, in := range inputs {
		fmt.Printf("\n[%d/%d] %s\n", i+1, len(inputs), in.Name)
		res := merchantResult{Name: in.Name}

		// 3.0 入参校验（先于上传，避免白传图后才被后端 400）
		// name 是按名称查重的主键，必须非空且 ≤64；后端对 type/lng/lat 是 binding:"required"
		// （对 int/float 而言 0 等于“缺失”→ 直接 400），所以这里也要求非零。
		if strings.TrimSpace(in.Name) == "" {
			res.Error = "缺少 name（商户名，按名称查重用，必填）"
			results = appendErr(results, res)
			continue
		}
		if len([]rune(in.Name)) > 64 {
			res.Error = fmt.Sprintf("name 超过 DB 上限 64 字符（当前 %d）", len([]rune(in.Name)))
			results = appendErr(results, res)
			continue
		}
		if in.Type <= 0 {
			res.Error = "type 必填且必须是正整数商户类型 id（用 query merchant-types 查；0 会被后端 400）"
			results = appendErr(results, res)
			continue
		}
		if in.Longitude == 0 || in.Latitude == 0 {
			res.Error = "longitude/latitude 必填且必须非零（真实 GCJ-02 经纬度；0 会被后端 400）"
			results = appendErr(results, res)
			continue
		}
		if len([]rune(in.Address)) > 128 {
			res.Error = fmt.Sprintf("address 超过 DB 上限 128 字符（当前 %d）", len([]rune(in.Address)))
			results = appendErr(results, res)
			continue
		}
		if in.Extra != "" && !json.Valid([]byte(in.Extra)) {
			res.Error = "extra 必须是合法 JSON 字符串（否则会被后端静默丢弃）"
			results = appendErr(results, res)
			continue
		}

		// 3.0.1 查重（按名称，poi 非空时再校验 poi 一致）
		if *flagDedup {
			if mid, err := c.findMerchant(in.Name, in.AddressPoiID); err != nil {
				res.Error = fmt.Sprintf("查重失败: %v", err)
				results = appendErr(results, res)
				continue
			} else if mid != "" {
				res.MerchantID = mid
				res.Skipped = true
				results = append(results, res)
				fmt.Printf("  ↷ 已存在，跳过 merchant_id=%s\n", mid)
				continue
			}
		}

		// 3.1 上传 logo（如果有）
		logoURL := "-" // 后端默认 "-"
		if in.LogoImage != "" {
			m, err := c.uploadMedia(in.LogoImage)
			if err != nil {
				res.Error = fmt.Sprintf("上传 logo 失败: %v", err)
				results = append(results, res)
				fmt.Println("  ✗", res.Error)
				continue
			}
			logoURL = m.MediaURL
			fmt.Printf("  ✓ logo -> %s\n", m.MediaURL)
		}

		// 3.2 上传相册图片
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

		// 3.3 创建商户
		// status / is_verified 留空默认 1：否则商户在 C 端地图/附近不可见
		// （后端 nearby 查询要求 status=1 AND is_verified=1）
		payload := map[string]any{
			"name":           in.Name,
			"name_new":       in.NameNew,
			"type":           in.Type,
			"description":    in.Description,
			"logo":           logoURL,
			"longitude":      in.Longitude,
			"latitude":       in.Latitude,
			"address":        in.Address,
			"address_poi_id": in.AddressPoiID,
			"status":         intOr(in.Status, 1),
			"score":          in.Score,
			"is_verified":    intOr(in.IsVerified, 1),
		}
		if len(medias) > 0 {
			payload["medias"] = medias
		}
		if in.OperatorUserID != "" {
			payload["operator_user_id"] = in.OperatorUserID
		}
		if len(in.AdminIDs) > 0 {
			payload["admin_ids"] = in.AdminIDs
		}
		if in.Extra != "" {
			payload["extra"] = in.Extra // 溯源/查重，可塞 source_id
		}

		var created struct {
			MerchantID string `json:"merchant_id"`
		}
		if err := c.postJSON("/merchants", payload, &created); err != nil {
			res.Error = fmt.Sprintf("创建商户失败: %v", err)
			results = append(results, res)
			fmt.Println("  ✗", res.Error)
			continue
		}
		res.MerchantID = created.MerchantID
		results = append(results, res)
		fmt.Printf("  ★ 商户创建成功 merchant_id=%s\n", created.MerchantID)
	}

	// 4) 输出结果
	out, _ := json.MarshalIndent(results, "", "  ")
	_ = os.WriteFile(*flagOut, out, 0o644)
	created, skipped := 0, 0
	for _, r := range results {
		if r.Skipped {
			skipped++
		} else if r.MerchantID != "" {
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

// findMerchant 按名称查重：POST /internal/merchants/list keyword=name，再精确比对名称
// （poi 非空时还要求 address_poi_id 一致，避免同名不同店误判）。命中返回 merchant_id。
func (c *client) findMerchant(name, poi string) (string, error) {
	var out struct {
		List []struct {
			MerchantID   string `json:"merchant_id"`
			Name         string `json:"name"`
			AddressPoiID string `json:"address_poi_id"`
		} `json:"list"`
	}
	body := map[string]any{"page": 1, "size": 100, "keyword": name}
	if err := c.postJSON("/merchants/list", body, &out); err != nil {
		return "", err
	}
	for _, m := range out.List {
		if m.Name != name { // keyword 是模糊匹配，这里精确比对
			continue
		}
		if poi != "" && m.AddressPoiID != poi { // 同名但 poi 不同，视为不同店
			continue
		}
		return m.MerchantID, nil
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

	// 取得文件内容 + 文件名
	data, name, err := readSource(src)
	if err != nil {
		return zero, err
	}

	// 组 multipart
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
		out.MediaType = 1 // 兜底为图片
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
