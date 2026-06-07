// 后台数据【查询 / 对比】工具 —— 给爬虫侧查重、核对用
//
// 子命令：
//
//	login                                 仅登录并打印 token
//	users      -keyword <kw> [-status N]   后台用户列表（keyword 匹配 user_id/昵称/手机号）
//	merchants  -keyword <kw> [-status N]   后台商户列表（keyword 匹配名称/merchant_id）
//	nows       [-keyword kw] [-now-id id] [-user-identifier 用户id或昵称]  后台气泡列表
//	poi        -keyword <kw> -city <城市>  关键词查 POI 列表（腾讯地图 WebService，返回 GCJ-02）
//
// 示例：
//
//	go run ./scripts/import/query users     -admin-user admin -admin-pass pass -keyword 13800138000
//	go run ./scripts/import/query merchants  -token 'xxx' -keyword 咖啡
//	go run ./scripts/import/query nows        -token 'xxx' -user-identifier <user_id>
//	go run ./scripts/import/query poi         -map-key <腾讯key> -city 北京 -keyword 星巴克
//
// 鉴权：admin 类命令(users/merchants/nows)需要 token —— -token 直接给，或留空用
// -admin-user/-admin-pass 登录换取；也支持 USER:<admin_id> 头（本工具用 Bearer）。
// poi 命令不走后台，直连腾讯地图 WebService，需要自备腾讯位置服务 key（-map-key 或 BUZZ_TENCENT_MAP_KEY）。
//
// 路由记得区分：后台在 {BASE}/internal/*；C 端在 {BASE}/api/v1/*（本工具只用后台 /internal）。
// 只依赖 Go 标准库。
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const apiPrefix = "/internal"

// 腾讯 POI / 地理编码 key：个人号优先，日配额用尽后切公司号（与 Zup 前端同源）。
// 只需 key、无需 SK。可用 -map-key 或 BUZZ_TENCENT_MAP_KEY 强制指定单一 key。
const (
	personalTencentMapKey = "ROMBZ-NP6RA-UD2K3-CVWY6-7CF6Q-J7BOX"
	companyTencentMapKey  = "KRABZ-SFJCW-YTZRK-YP25X-2EFC6-ZBFCY"
)

var personalMapKeySkipped bool

// httpTimeout 给后台请求加超时
const httpTimeout = 60 * time.Second

func resolveMapKeyChain(rest map[string]string) []string {
	if k := rest["map-key"]; k != "" {
		return []string{k}
	}
	if k := env("BUZZ_TENCENT_MAP_KEY", ""); k != "" {
		return []string{k}
	}
	if personalMapKeySkipped {
		return []string{companyTencentMapKey}
	}
	return []string{personalTencentMapKey, companyTencentMapKey}
}

// resolveMapKey 取当前首选腾讯 key（兼容旧调用）
func resolveMapKey(rest map[string]string) string {
	chain := resolveMapKeyChain(rest)
	return chain[0]
}

func shouldFallbackFromPersonal(status int, message string) string {
	if status == 120 || status == 121 {
		return "quota"
	}
	if strings.Contains(message, "调用量") || strings.Contains(message, "上限") || strings.Contains(message, "配额") {
		return "quota"
	}
	if status == 110 || status == 111 {
		return "auth"
	}
	return ""
}

// tencentGet 带 key 轮换的腾讯 WebService GET（个人号 → 公司号）
func tencentGet(reqURL string, rest map[string]string) ([]byte, error) {
	u, err := url.Parse(reqURL)
	if err != nil {
		return nil, err
	}
	q := u.Query()
	keys := resolveMapKeyChain(rest)
	var lastErr error

	for i, key := range keys {
		q.Set("key", key)
		u.RawQuery = q.Encode()
		resp, err := http.Get(u.String())
		if err != nil {
			return nil, err
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		var head struct {
			Status  int    `json:"status"`
			Message string `json:"message"`
		}
		if err := json.Unmarshal(raw, &head); err != nil {
			return nil, fmt.Errorf("解析腾讯地图响应失败: %s", truncate(string(raw), 300))
		}
		if head.Status == 0 {
			return raw, nil
		}
		lastErr = fmt.Errorf("腾讯地图返回错误 status=%d msg=%s", head.Status, head.Message)
		if reason := shouldFallbackFromPersonal(head.Status, head.Message); reason != "" && key == personalTencentMapKey && i+1 < len(keys) {
			personalMapKeySkipped = true
			hint := "日配额已满"
			if reason == "auth" {
				hint = "不可用（可能需在腾讯控制台关闭 SK 签名校验或配置 WebService 白名单）"
			}
			fmt.Fprintf(os.Stderr, "[query] 个人 key %s，切换公司 key: %s\n", hint, head.Message)
			continue
		}
		return nil, lastErr
	}
	return nil, lastErr
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(1)
	}
	switch os.Args[1] {
	case "login":
		cmdLogin(os.Args[2:])
	case "users":
		cmdAdminList("users", "/users/list", os.Args[2:])
	case "merchants":
		cmdAdminList("merchants", "/merchants/list", os.Args[2:])
	case "merchant-types":
		cmdMerchantTypes(os.Args[2:])
	case "nows":
		cmdNows(os.Args[2:])
	case "poi":
		cmdPoi(os.Args[2:])
	case "geocode":
		cmdGeocode(os.Args[2:])
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "未知子命令: %s\n\n", os.Args[1])
		usage()
		os.Exit(1)
	}
}

func usage() {
	fmt.Print(`后台数据查询/对比工具

用法:
  query login                                            登录并打印 token
  query users      -keyword <kw> [-status N] [-page 1] [-size 20]
  query merchants  -keyword <kw> [-status N] [-page 1] [-size 20]
  query merchant-types [-keyword kw]                     列出可用商户类型 id（建商户的 type 取此 id）
  query nows       [-keyword kw] [-now-id id] [-user-identifier 用户id或昵称] [-status 1|-1] [-type 1|2|3]
  query poi        -keyword <kw> [-city 城市|全国] [-map-key <腾讯key>] [-page-size 10] [-page-index 1]
  query geocode    -address <地址> [-city 城市] [-map-key <腾讯key>]   地址→经纬度(GCJ-02)

通用(admin 命令): -base <url>  -token <bearer>  -admin-user <u>  -admin-pass <p>（支持 -flag=value）
环境变量: BUZZ_API_BASE  BUZZ_TOKEN  BUZZ_ADMIN_USER  BUZZ_ADMIN_PASS  BUZZ_TENCENT_MAP_KEY
说明: poi/geocode 内置个人号+公司号 key 链（个人优先，日配额用尽自动切公司号；只需 key、无需 SK），可用 -map-key 强制指定。
`)
}

// ============================================================
// 子命令实现
// ============================================================

// commonFlags 解析所有 admin 命令共用的参数（手动解析，避免引入 flag 包的子集复杂度）
type commonFlags struct {
	base, token, adminUser, adminPass string
	rest                              map[string]string // 其余 -k v 参数
}

func parseFlags(args []string) commonFlags {
	cf := commonFlags{
		base:      env("BUZZ_API_BASE", "http://localhost:80"),
		token:     env("BUZZ_TOKEN", ""),
		adminUser: env("BUZZ_ADMIN_USER", ""),
		adminPass: env("BUZZ_ADMIN_PASS", ""),
		rest:      map[string]string{},
	}
	for i := 0; i < len(args); i++ {
		if !strings.HasPrefix(args[i], "-") {
			continue
		}
		k := strings.TrimPrefix(strings.TrimPrefix(args[i], "-"), "-") // 同时支持 - 和 --
		var v string
		if key, val, ok := strings.Cut(k, "="); ok { // 支持 -flag=value
			k, v = key, val
		} else if i+1 < len(args) { // 支持 -flag value
			v = args[i+1]
			i++
		} else {
			continue // 末尾孤立 flag 无值
		}
		switch k {
		case "base":
			cf.base = v
		case "token":
			cf.token = v
		case "admin-user":
			cf.adminUser = v
		case "admin-pass":
			cf.adminPass = v
		default:
			cf.rest[k] = v
		}
	}
	cf.base = strings.TrimRight(cf.base, "/")
	return cf
}

func cmdLogin(args []string) {
	cf := parseFlags(args)
	c := mustAuthed(cf)
	fmt.Println(c.token)
}

func cmdAdminList(name, path string, args []string) {
	cf := parseFlags(args)
	c := mustAuthed(cf)

	body := map[string]any{
		"page":    atoiDefault(cf.rest["page"], 1),
		"size":    atoiDefault(cf.rest["size"], 20),
		"keyword": cf.rest["keyword"],
	}
	if s, ok := cf.rest["status"]; ok {
		body["status"] = atoiDefault(s, 0)
	}
	if name == "users" {
		if uid := cf.rest["user-id"]; uid != "" {
			body["user_id"] = uid
		}
	}

	data, err := c.postJSON(path, body)
	if err != nil {
		fatal("%s 查询失败: %v", name, err)
	}
	printList(data)
}

// cmdMerchantTypes 列出可用的商户类型 id（建商户的 type 字段取这里的值）
// POST /internal/merchant-types/list -> data:{ list:[{id,type,name,sort,icon}] }
func cmdMerchantTypes(args []string) {
	cf := parseFlags(args)
	c := mustAuthed(cf)
	body := map[string]any{"page": 1, "size": 200, "keyword": cf.rest["keyword"]}
	data, err := c.postJSON("/merchant-types/list", body)
	if err != nil {
		fatal("merchant-types 查询失败: %v", err)
	}
	var out struct {
		List []struct {
			ID   int    `json:"id"`
			Type int    `json:"type"`
			Name string `json:"name"`
		} `json:"list"`
	}
	_ = json.Unmarshal(data, &out)
	fmt.Println("可用商户类型（建商户的 type 字段填 id 列的值）:")
	for _, t := range out.List {
		fmt.Printf("  id=%-4d type=%-4d name=%s\n", t.ID, t.Type, t.Name)
	}
	fmt.Printf("\n共 %d 个\n", len(out.List))
}

func cmdNows(args []string) {
	cf := parseFlags(args)
	c := mustAuthed(cf)

	body := map[string]any{
		"page": atoiDefault(cf.rest["page"], 1),
		"size": atoiDefault(cf.rest["size"], 20),
	}
	for _, k := range []string{"keyword", "now_id", "user_identifier"} {
		// 兼容连字符写法 -now-id / -user-identifier
		v := cf.rest[k]
		if v == "" {
			v = cf.rest[strings.ReplaceAll(k, "_", "-")]
		}
		if v != "" {
			body[k] = v
		}
	}
	if s, ok := cf.rest["status"]; ok {
		body["status"] = atoiDefault(s, 0)
	}
	if t, ok := cf.rest["type"]; ok {
		body["type"] = atoiDefault(t, 0)
	}

	data, err := c.postJSON("/nows/list", body)
	if err != nil {
		fatal("nows 查询失败: %v", err)
	}
	printList(data)
}

// cmdPoi 关键词查 POI：直连腾讯地图 WebService（与前端选点同源，返回 GCJ-02）
// 文档：https://lbs.qq.com/service/webService/webServiceGuide/webServiceSearch
func cmdPoi(args []string) {
	cf := parseFlags(args)
	keyword := cf.rest["keyword"]
	city := strOrDefault(cf.rest["city"], "全国") // 不给城市就全国范围搜
	if keyword == "" {
		fatal("poi 需要 -keyword（-city 默认 全国；-map-key 可覆盖内置 key 链）")
	}

	q := url.Values{}
	q.Set("keyword", keyword)
	q.Set("boundary", fmt.Sprintf("region(%s,1)", city)) // region(城市,是否自动扩大范围)
	q.Set("page_size", strOrDefault(cf.rest["page-size"], "10"))
	q.Set("page_index", strOrDefault(cf.rest["page-index"], "1"))
	reqURL := "https://apis.map.qq.com/ws/place/v1/search?" + q.Encode()

	raw, err := tencentGet(reqURL, cf.rest)
	if err != nil {
		fatal("%v", err)
	}

	var out struct {
		Status  int    `json:"status"`
		Message string `json:"message"`
		Count   int    `json:"count"`
		Data    []struct {
			ID       string `json:"id"`      // POI id —— 即 address_poi_id / location_poi_id
			Title    string `json:"title"`   // 名称
			Address  string `json:"address"` // 地址
			Tel      string `json:"tel"`
			Category string `json:"category"`
			Location struct {
				Lat float64 `json:"lat"` // 纬度 (GCJ-02)
				Lng float64 `json:"lng"` // 经度 (GCJ-02)
			} `json:"location"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		fatal("解析腾讯地图响应失败: %s", truncate(string(raw), 300))
	}
	if out.Status != 0 {
		fatal("腾讯地图返回错误 status=%d msg=%s", out.Status, out.Message)
	}

	fmt.Printf("关键词「%s」在「%s」找到 %d 个 POI（坐标为 GCJ-02，可直接填入 merchant/now）:\n\n", keyword, city, len(out.Data))
	for i, p := range out.Data {
		fmt.Printf("%2d. %s\n", i+1, p.Title)
		fmt.Printf("    poi_id   : %s\n", p.ID)
		fmt.Printf("    address  : %s\n", p.Address)
		fmt.Printf("    lng,lat  : %.6f, %.6f   (经度,纬度 GCJ-02)\n", p.Location.Lng, p.Location.Lat)
		if p.Category != "" {
			fmt.Printf("    category : %s\n", p.Category)
		}
		fmt.Println()
	}
	// 同时给出可直接粘贴的 JSON 片段
	pretty, _ := json.MarshalIndent(out.Data, "", "  ")
	fmt.Println("--- 原始 data（可摘字段填入导入数据）---")
	fmt.Println(string(pretty))
}

// cmdGeocode 地址 → 经纬度（腾讯地图 Geocoder，返回 GCJ-02）
// 只有文本地址、没有 POI 时用它拿坐标。文档：lbs.qq.com/service/webService/webServiceGuide/webServiceGeocoder
func cmdGeocode(args []string) {
	cf := parseFlags(args)
	address := cf.rest["address"]
	if address == "" {
		fatal("geocode 需要 -address（可选 -city 提高命中；-map-key 可覆盖内置 key 链）")
	}
	addr := address
	if city := cf.rest["city"]; city != "" {
		addr = city + address // 腾讯建议地址带上城市前缀
	}

	q := url.Values{}
	q.Set("address", addr)
	q.Set("output", "json")
	reqURL := "https://apis.map.qq.com/ws/geocoder/v1/?" + q.Encode()

	raw, err := tencentGet(reqURL, cf.rest)
	if err != nil {
		fatal("%v", err)
	}

	var out struct {
		Status  int    `json:"status"`
		Message string `json:"message"`
		Result  struct {
			Title    string `json:"title"`
			Location struct {
				Lat float64 `json:"lat"`
				Lng float64 `json:"lng"`
			} `json:"location"`
			AddressComponents struct {
				Province string `json:"province"`
				City     string `json:"city"`
				District string `json:"district"`
			} `json:"address_components"`
			Reliability int `json:"reliability"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		fatal("解析腾讯地图响应失败: %s", truncate(string(raw), 300))
	}
	if out.Status != 0 {
		fatal("腾讯地图返回错误 status=%d msg=%s", out.Status, out.Message)
	}
	r := out.Result
	fmt.Printf("地址「%s」解析结果（GCJ-02）:\n", addr)
	fmt.Printf("  lng,lat     : %.6f, %.6f   (经度,纬度，可直接填 longitude/latitude)\n", r.Location.Lng, r.Location.Lat)
	fmt.Printf("  province/city/district : %s / %s / %s\n", r.AddressComponents.Province, r.AddressComponents.City, r.AddressComponents.District)
	fmt.Printf("  reliability : %d（1~10，越大越可信）\n", r.Reliability)
	fmt.Println("\n注意：geocoder 不返回 POI id（address_poi_id）；要 poi 用 `query poi`。")
}

// ============================================================
// HTTP 客户端
// ============================================================

type client struct {
	base, token string
	hc          http.Client
}

type apiEnvelope struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

// mustAuthed 确保有 token：没有就用 admin-user/admin-pass 登录
func mustAuthed(cf commonFlags) *client {
	c := &client{base: cf.base, token: cf.token, hc: http.Client{Timeout: httpTimeout}}
	if c.token != "" {
		return c
	}
	if cf.adminUser == "" || cf.adminPass == "" {
		fatal("缺少 token，且未提供 -admin-user/-admin-pass 用于登录")
	}
	tok, err := c.login(cf.adminUser, cf.adminPass)
	if err != nil {
		fatal("登录失败: %v", err)
	}
	c.token = tok
	return c
}

func (c *client) login(user, pass string) (string, error) {
	data, err := c.postJSON("/auth/login", map[string]string{"username": user, "password": pass})
	if err != nil {
		return "", err
	}
	var out struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return "", err
	}
	if out.Token == "" {
		return "", fmt.Errorf("登录响应未返回 token")
	}
	return out.Token, nil
}

// postJSON 发送 JSON 请求，返回 envelope.data（json.RawMessage）
func (c *client) postJSON(path string, body any) (json.RawMessage, error) {
	buf, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, c.base+apiPrefix+path, bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("http %d: %s", resp.StatusCode, truncate(string(raw), 300))
	}
	var env apiEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("响应非 JSON: %s", truncate(string(raw), 300))
	}
	if env.Code != 0 {
		return nil, fmt.Errorf("业务错误 code=%d msg=%s", env.Code, env.Message)
	}
	return env.Data, nil
}

// ============================================================
// 输出与工具
// ============================================================

// printList 打印 {list, pagination} 形式的后台列表
func printList(data json.RawMessage) {
	var wrap struct {
		List       []json.RawMessage `json:"list"`
		Pagination struct {
			Total       int `json:"total"`
			CurrentPage int `json:"current_page"`
			PerPage     int `json:"per_page"`
		} `json:"pagination"`
	}
	_ = json.Unmarshal(data, &wrap)

	pretty, _ := json.MarshalIndent(json.RawMessage(data), "", "  ")
	fmt.Println(string(pretty))
	fmt.Printf("\n本页 %d 条 | total=%d | current_page=%d | per_page=%d\n",
		len(wrap.List), wrap.Pagination.Total, wrap.Pagination.CurrentPage, wrap.Pagination.PerPage)
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func atoiDefault(s string, def int) int {
	if s == "" {
		return def
	}
	n := 0
	neg := false
	for i, ch := range s {
		if i == 0 && ch == '-' {
			neg = true
			continue
		}
		if ch < '0' || ch > '9' {
			return def
		}
		n = n*10 + int(ch-'0')
	}
	if neg {
		n = -n
	}
	return n
}

func strOrDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
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
