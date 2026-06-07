// 微信/腾讯 IM 群聊【自动建群】工具
//
// 说明：本项目“群聊”用的是【腾讯云 IM（即时通信 IM）】，不是微信的群。
// 建群直接调腾讯 IM REST API（console.tim.qq.com），用「管理员 UserSig」鉴权，
// 与后端 infra/pkg/tencentim.CreateGroup 完全一致。所以本工具【不依赖后台 token】，
// 只要有 IM 的 SDKAppID + 密钥(key) 即可建群。
//
// 子命令：
//
//	create        建群（单个或 -f 批量）→ 打印 group_id
//	import-account 预注册一个 IM 账号（群主不存在时用）
//	usersig        生成某 uid 的 UserSig（调试/登录用）
//	info           查群信息 -group <id>
//
// 示例：
//
//	go run ./scripts/import/group create -owner <发布者user_id> -name "示例气泡群" -type Public
//	go run ./scripts/import/group create -f scripts/import/group/sample.json
//	go run ./scripts/import/group import-account -uid <user_id> -nick 张三 -avatar https://x/a.jpg
//	go run ./scripts/import/group usersig -uid <user_id>
//	go run ./scripts/import/group info -group @TGS#xxxxx
//
// 凭据（已内置默认，与 app/constat/tencentim.go 一致，可用 flag/env 覆盖）：
//
//	SDKAppID = 1600107795
//	IM Key   = 34b1...（IM 控制台「密钥」，务必保密）
//	管理员标识 identifier = administrator（需在 IM 控制台配置为 App 管理员）
//
// 依赖腾讯官方签名库 tls-sig-api-v2-golang（项目已引入），其余为标准库。
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/tencentyun/tls-sig-api-v2-golang/tencentyun"
)

// ============================================================
// 凭据（默认与后端 constat 一致；可用 flag 或环境变量覆盖）
// ============================================================

const (
	defaultSDKAppID = 1600107795
	defaultIMKey    = "34b157159d5b5f21c5b6b02e43d3fb4e904b1a3c68092585e9cd36b67c841b9d"
	adminID         = "administrator" // App 管理员账号标识，需在 IM 控制台配置
	adminSigExpire  = 86400 * 180     // 管理员 sig 有效期（秒）
)

const imBase = "https://console.tim.qq.com/v4/"

var (
	sdkAppID = envInt("BUZZ_IM_SDKAPPID", defaultSDKAppID)
	imKey    = env("BUZZ_IM_KEY", defaultIMKey)
)

// 合法群类型（与腾讯 IM / 后端校验一致）
var validGroupTypes = map[string]bool{
	"Public": true, "Private": true, "ChatRoom": true, "AVChatRoom": true, "Community": true,
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(1)
	}
	switch os.Args[1] {
	case "create":
		cmdCreate(os.Args[2:])
	case "import-account":
		cmdImportAccount(os.Args[2:])
	case "usersig":
		cmdUsersig(os.Args[2:])
	case "info":
		cmdInfo(os.Args[2:])
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "未知子命令: %s\n\n", os.Args[1])
		usage()
		os.Exit(1)
	}
}

func usage() {
	fmt.Print(`腾讯 IM 自动建群工具（凭据已内置，可用 flag/env 覆盖）

用法:
  group create  -owner <user_id> [-name n] [-type Public] [-intro 简介] [-notice 公告]
                [-face url] [-max 200] [-apply FreeAccess|NeedPermission|DisableApply]
  group create  -f groups.json [-out groups.result.json]      批量建群
  group import-account -uid <user_id> [-nick 昵称] [-avatar url]
  group usersig -uid <user_id> [-expire 秒]
  group info    -group <group_id>

群类型 type: Public(陌生人社交群,默认) / Private(好友工作群) / ChatRoom / AVChatRoom(直播) / Community(社群)
覆盖凭据: -sdkappid / -key（或 env BUZZ_IM_SDKAPPID / BUZZ_IM_KEY）
`)
}

// ============================================================
// create —— 建群（单个 / 批量）
// ============================================================

// GroupInput 批量建群的一条输入
type GroupInput struct {
	Owner            string `json:"owner"`                       // 群主 user_id（必填，通常是气泡发布者）
	Name             string `json:"name"`                        // 群名称
	Type             string `json:"type"`                        // 群类型，留空默认 Public
	Introduction     string `json:"introduction"`                // 群简介
	Notification     string `json:"notification"`                // 群公告
	FaceURL          string `json:"face_url"`                    // 群头像 URL
	MaxMemberCount   uint32 `json:"max_member_count"`            // 最大人数
	ApplyJoinOption  string `json:"apply_join_option"`           // 申请加群选项
	GroupID          string `json:"group_id,omitempty"`          // 可选：自定义群 id（不填由腾讯分配）
	ImportOwnerNick  string `json:"import_owner_nick,omitempty"` // 可选：建群前先把群主注册成 IM 账号
	ImportOwnerFace  string `json:"import_owner_avatar,omitempty"`
	importOwnerFirst bool   // 内部：是否需要先注册群主
}

type groupResult struct {
	Owner   string `json:"owner"`
	Name    string `json:"name"`
	GroupID string `json:"group_id,omitempty"`
	Error   string `json:"error,omitempty"`
}

func cmdCreate(args []string) {
	fs := flag.NewFlagSet("create", flag.ExitOnError)
	bindCreds(fs)
	var (
		file        = fs.String("f", "", "批量建群输入 JSON 文件（与单条参数二选一）")
		out         = fs.String("out", "groups.result.json", "批量结果输出文件")
		owner       = fs.String("owner", "", "群主 user_id")
		name        = fs.String("name", "", "群名称")
		gtype       = fs.String("type", "Public", "群类型")
		intro       = fs.String("intro", "", "群简介")
		notice      = fs.String("notice", "", "群公告")
		face        = fs.String("face", "", "群头像 URL")
		maxN        = fs.Uint("max", 0, "最大人数（0=按腾讯默认）")
		apply       = fs.String("apply", "", "申请加群选项 FreeAccess|NeedPermission|DisableApply")
		importOwner = fs.Bool("import-owner", false, "建群前先把群主注册成 IM 账号（群主不存在时用）")
	)
	_ = fs.Parse(args)

	var inputs []GroupInput
	if *file != "" {
		raw, err := os.ReadFile(*file)
		if err != nil {
			fatal("读取输入文件失败: %v", err)
		}
		if err := json.Unmarshal(raw, &inputs); err != nil {
			fatal("解析输入 JSON 失败: %v", err)
		}
	} else {
		if *owner == "" {
			fatal("create 需要 -owner（或用 -f 批量）")
		}
		inputs = []GroupInput{{
			Owner: *owner, Name: *name, Type: *gtype, Introduction: *intro,
			Notification: *notice, FaceURL: *face, MaxMemberCount: uint32(*maxN),
			ApplyJoinOption: *apply, importOwnerFirst: *importOwner,
		}}
	}

	results := make([]groupResult, 0, len(inputs))
	for i, in := range inputs {
		if in.Type == "" {
			in.Type = "Public"
		}
		fmt.Printf("\n[%d/%d] owner=%s name=%s type=%s\n", i+1, len(inputs), in.Owner, in.Name, in.Type)
		res := groupResult{Owner: in.Owner, Name: in.Name}

		if in.Owner == "" {
			res.Error = "缺少 owner（群主 user_id）"
			results = append(results, res)
			fmt.Println("  ✗", res.Error)
			continue
		}
		if !validGroupTypes[in.Type] {
			res.Error = "群类型非法: " + in.Type + "（Public/Private/ChatRoom/AVChatRoom/Community）"
			results = append(results, res)
			fmt.Println("  ✗", res.Error)
			continue
		}

		// 可选：先注册群主 IM 账号
		if in.importOwnerFirst || in.ImportOwnerNick != "" || in.ImportOwnerFace != "" {
			if err := importAccount(in.Owner, in.ImportOwnerNick, in.ImportOwnerFace); err != nil {
				fmt.Printf("  ! 预注册群主账号失败（可能已存在，忽略）: %v\n", err)
			} else {
				fmt.Println("  ✓ 已注册群主 IM 账号")
			}
		}

		gid, err := createGroup(in)
		if err != nil {
			res.Error = fmt.Sprintf("建群失败: %v", err)
			results = append(results, res)
			fmt.Println("  ✗", res.Error)
			continue
		}
		res.GroupID = gid
		results = append(results, res)
		fmt.Printf("  ★ 建群成功 group_id=%s\n", gid)
	}

	if *file != "" {
		b, _ := json.MarshalIndent(results, "", "  ")
		_ = os.WriteFile(*out, b, 0o644)
		ok := 0
		for _, r := range results {
			if r.GroupID != "" {
				ok++
			}
		}
		fmt.Printf("\n完成：成功 %d / 共 %d，结果已写入 %s\n", ok, len(results), *out)
	}
}

// ============================================================
// 其它子命令
// ============================================================

func cmdImportAccount(args []string) {
	fs := flag.NewFlagSet("import-account", flag.ExitOnError)
	bindCreds(fs)
	uid := fs.String("uid", "", "要注册的 user_id")
	nick := fs.String("nick", "", "昵称")
	avatar := fs.String("avatar", "", "头像 URL")
	_ = fs.Parse(args)
	if *uid == "" {
		fatal("import-account 需要 -uid")
	}
	if err := importAccount(*uid, *nick, *avatar); err != nil {
		fatal("注册账号失败: %v", err)
	}
	fmt.Printf("已注册 IM 账号 uid=%s\n", *uid)
}

func cmdUsersig(args []string) {
	fs := flag.NewFlagSet("usersig", flag.ExitOnError)
	bindCreds(fs)
	uid := fs.String("uid", "", "user_id")
	expire := fs.Int("expire", 86400*180, "有效期(秒)")
	_ = fs.Parse(args)
	if *uid == "" {
		fatal("usersig 需要 -uid")
	}
	sig, err := tencentyun.GenUserSig(sdkAppID, imKey, *uid, *expire)
	if err != nil {
		fatal("生成 UserSig 失败: %v", err)
	}
	fmt.Println(sig)
}

func cmdInfo(args []string) {
	fs := flag.NewFlagSet("info", flag.ExitOnError)
	bindCreds(fs)
	group := fs.String("group", "", "group_id")
	_ = fs.Parse(args)
	if *group == "" {
		fatal("info 需要 -group")
	}
	raw, err := imPost("group_open_http_svc/get_group_info", map[string]any{"GroupIdList": []string{*group}})
	if err != nil {
		fatal("查群失败: %v", err)
	}
	var pretty bytes.Buffer
	_ = json.Indent(&pretty, raw, "", "  ")
	fmt.Println(pretty.String())
}

// ============================================================
// 腾讯 IM REST 调用
// ============================================================

// createGroup 调用 create_group，返回 group_id
func createGroup(in GroupInput) (string, error) {
	body := map[string]any{
		"Type":          in.Type,
		"Owner_Account": in.Owner,
	}
	putStr(body, "Name", in.Name)
	putStr(body, "Introduction", in.Introduction)
	putStr(body, "Notification", in.Notification)
	putStr(body, "FaceUrl", in.FaceURL)
	putStr(body, "GroupId", in.GroupID)
	putStr(body, "ApplyJoinOption", in.ApplyJoinOption)
	if in.MaxMemberCount > 0 {
		body["MaxMemberCount"] = in.MaxMemberCount
	}

	raw, err := imPost("group_open_http_svc/create_group", body)
	if err != nil {
		return "", err
	}
	var r struct {
		ActionStatus string `json:"ActionStatus"`
		ErrorCode    int    `json:"ErrorCode"`
		ErrorInfo    string `json:"ErrorInfo"`
		GroupID      string `json:"GroupId"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return "", fmt.Errorf("解析响应失败: %s", truncate(string(raw), 300))
	}
	if r.ActionStatus != "OK" || r.ErrorCode != 0 {
		return "", fmt.Errorf("code=%d info=%s", r.ErrorCode, r.ErrorInfo)
	}
	return r.GroupID, nil
}

// importAccount 调用 account_import 注册 IM 账号
func importAccount(uid, nick, avatar string) error {
	body := map[string]any{"UserID": uid}
	putStr(body, "Nick", nick)
	putStr(body, "FaceUrl", avatar)
	raw, err := imPost("im_open_login_svc/account_import", body)
	if err != nil {
		return err
	}
	var r struct {
		ActionStatus string `json:"ActionStatus"`
		ErrorCode    int    `json:"ErrorCode"`
		ErrorInfo    string `json:"ErrorInfo"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return fmt.Errorf("解析响应失败: %s", truncate(string(raw), 300))
	}
	if r.ActionStatus != "OK" || r.ErrorCode != 0 {
		return fmt.Errorf("code=%d info=%s", r.ErrorCode, r.ErrorInfo)
	}
	return nil
}

// imPost 用管理员 UserSig 调腾讯 IM REST 接口
func imPost(svc string, body any) ([]byte, error) {
	sig, err := tencentyun.GenUserSig(sdkAppID, imKey, adminID, adminSigExpire)
	if err != nil {
		return nil, fmt.Errorf("生成管理员 UserSig 失败: %w", err)
	}
	random := rand.New(rand.NewSource(time.Now().UnixNano())).Intn(10000000)
	// usersig 用的是自定义 base64（字符集 *-_ 均 URL 安全），与后端一致直接拼接、不做转义
	url := fmt.Sprintf("%s%s?sdkappid=%d&identifier=%s&usersig=%s&random=%d&contenttype=json",
		imBase, svc, sdkAppID, adminID, sig, random)

	buf, _ := json.Marshal(body)
	hc := http.Client{Timeout: 30 * time.Second}
	resp, err := hc.Post(url, "application/json", bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("http %d: %s", resp.StatusCode, truncate(string(raw), 300))
	}
	return raw, nil
}

// ============================================================
// 工具
// ============================================================

// bindCreds 给子命令注册可覆盖凭据的 flag
func bindCreds(fs *flag.FlagSet) {
	fs.IntVar(&sdkAppID, "sdkappid", sdkAppID, "IM SDKAppID")
	fs.StringVar(&imKey, "key", imKey, "IM 密钥(key)")
}

func putStr(m map[string]any, k, v string) {
	if v != "" {
		m[k] = v
	}
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
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
