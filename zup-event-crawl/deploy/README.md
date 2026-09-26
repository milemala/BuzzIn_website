# 把页面和审核台放到现有阿里云

这台机器上已经在跑 Zup 后台和官网。页面和审核台是加在旁边的，不重启、不替换正在跑的后台。

## 2026-09-26 已经做过的事

服务器：阿里云，机器名 `zup-prod-01`，公网 IP `47.95.5.77`。用 `root` 登录。这台机器不接受密码登录，只接受钥匙。

钥匙是一对文件，放在你这台 Mac 上：

- 私钥：`~/.ssh/id_ed25519`（相当于开门的钥匙，不要复制到别处，不要提交到 git）
- 公钥：`~/.ssh/id_ed25519.pub`（备注 `weiming-mac-zup-website`）

公钥的那一行已经写进服务器的 `/root/.ssh/authorized_keys`。所以从这台 Mac 可以用 `ssh root@47.95.5.77` 登录，也可以传文件。删掉服务器上的那一行，这条通道就断了。

官网页面已经传到 `/data/www/buzzin-home`。打开地址是 http://nowmap.cn/ 。`www.nowmap.cn` 会跳到 `nowmap.cn`。你电脑上的活动页文件夹叫 `events`，服务器上叫 `event`，所以活动页地址是 `http://nowmap.cn/event/页面名.html`。

这两个验证文件不能删：

- `/data/www/buzzin-home/MP_verify_9u35pQWZa7aCn4aF.txt`
- `/data/www/buzzin-home/verify_2f524bbb3a8b1c14de5389cdca33d341.html`

不要动这些现有服务：

- `zup.nowmap.cn`：现有后台，nginx 转给 `api-zup-rs_backend`
- `admin.nowmap.cn`、`api.nowmap.cn`：目录是 `/data/www/buzzin-web` 和 `/data/www/buzzin-api`
- 官网占用 80 端口。审核台不要占用 80 或 443

审核台已经装到 `/opt/zup-review`，服务名 `zup-review`，开机自启，监听 `0.0.0.0:8790`。服务器上的 Node 是 `v22.20.0`，装在 `/usr/local`。2026-09-26 的包是 368MB：还没结束的活动 861 场、商户 2148 家、封面 2747 张。已经结束的 6183 场活动没有放上去。你电脑上的原数据库仍保留全部历史。

审核台登录密码写在 `zup-event-crawl/data/review-password` 里不带 `#` 的那一行。这个文件不进 git。公网打开 http://47.95.5.77:8790 要输这行密码。本机打开 http://127.0.0.1:8790 不用密码。

还没做完：阿里云防火墙还没放行 TCP `8790`。服务器自己能打开审核台，从外网还连不上。放行这一条之后，公网地址才能用。不要改 80 端口上已有的网站和后台。

抓豆瓣、小红书、大众点评仍然在你自己的电脑上做，不放到云上。云上的商户名单、文案池、已选商户以 `/opt/zup-review/data/review.db` 为准。不要一边在家里电脑改名单、一边在云上发布。

## 第 1 步：只看，先不要改

在你自己的电脑上登录服务器（把 IP 换成你的）：

```bash
ssh root@你的公网IP
```

登录后依次执行下面几句，把屏幕上的结果记下来。这一步不改任何文件。

```bash
ss -lntp | awk 'NR==1 || /:80 |:443 |:8790 |:8787 |:8788 /'
ls /etc/nginx/conf.d /etc/nginx/sites-enabled 2>/dev/null
nginx -T 2>/dev/null | awk '/server_name|root |proxy_pass|listen /'
```

你要确认三件事：

1. 官网网页实际放在哪个文件夹（`root` 那一行）。
2. `8790` 现在没有被占用。审核台要用这个端口，给公网打开，打开前要登录。
3. 已经在听 `80` / `443` 的是官网和后台，后面不要改它们的端口，也不要停它们的服务。

把这三样结果发回来，再做第 2 步。文件夹路径没对上之前，不要往服务器上覆盖文件。

## 第 2 步：上传网页

网页和审核台分开传。网页里不要带审核台、抓取数据、表格和压缩包。

在你自己的电脑上，进入这个项目的根目录，执行（把 IP 和网页目录换成第 1 步看到的）：

```bash
rsync -av \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'zup-event-crawl' \
  --exclude 'demo/profile-proxy/node_modules' \
  --exclude 'demo/profile-proxy/.env' \
  --exclude '参考资料' \
  --exclude 'AI建档-v3-后端交接包' \
  --exclude 'AI建档-v3-后端交接包-20260807' \
  --exclude '*.zip' \
  --exclude '*副本*' \
  ./ root@47.95.5.77:/data/www/buzzin-home/
```

活动页不要传成 `events` 这个文件夹名。传到服务器的 `event` 目录：

```bash
rsync -av \
  --exclude '*副本*' \
  --exclude '*.zip' \
  events/ root@47.95.5.77:/data/www/buzzin-home/event/
```

不要加会删除服务器多余文件的参数。那两个验证文件必须留在服务器上。

以后你改完页面，再执行一次上面同一句，网址上就是新的。

## 第 3 步：上传审核台

审核台单独放在 `/opt/zup-review`，不放进网页目录。

在你自己的电脑上，进入 `zup-event-crawl` 目录：

```bash
bash scripts/pack-cloud.sh
scp data/zup-review-cloud.tar.gz root@你的公网IP:/opt/
```

这个包只带还没结束的活动、全部商户和对应封面。已经结束的活动不会打进去。你电脑上的原数据库仍保留这些历史。

登录服务器后：

```bash
mkdir -p /opt/zup-review
tar -xzf /opt/zup-review-cloud.tar.gz -C /opt/zup-review
bash /opt/zup-review/deploy/install-on-cloud.sh
```

安装脚本会装好 Node，并设置成开机自动启动。审核台用 `8790`，不占用官网的 `80` / `443`。

到阿里云安全组里放行 TCP `8790`。只放行这一条，不要改后台和官网已经在用的端口。

## 第 4 步：用公网地址打开审核台

浏览器打开：

http://你的公网IP:8790/merchant-bubbles.html

页面会先要密码。密码是你电脑上 `zup-event-crawl/data/review-password` 里那一行，上传审核台时会一起带到服务器。

本机用 http://127.0.0.1:8790 打开时不用输密码。换成公网 IP 就要输。

想改密码：改这一行，重新打包上传，在服务器上执行 `systemctl restart zup-review`。

## 以后怎么改

一律先在这台 Mac 的项目里改，再把改过的文件同步到服务器。不要直接改服务器上的代码。服务器上改过的程序，下次从电脑同步时会被盖掉，两边会对不上。

你改完后说一声「同步到服务器」。由这边登录服务器完成同步，不用你自己敲命令。

- 官网页面：只上传改过的网页、`css`、`js`、`images`。活动页放进服务器的 `event` 目录，不是 `events`。不用重启审核台。上传后用 http://nowmap.cn/ 对应地址查看。不要删除那两个验证文件。
- 审核台程序：只上传改过的程序和页面到 `/opt/zup-review`，然后执行 `systemctl restart zup-review`。不要覆盖云上的 `data/review.db`、`data/image-composed`、`data/review-password`。
- 商户名单、文案池、已选商户：部署之后以云上那份数据库为准。在浏览器里打开云上的审核台来改。不要在家里电脑的审核台里改名单再传上去。
- 只有你明确说「用电脑上的名单覆盖云上」时，才重新打包数据库和封面。打包仍会去掉已经结束的活动。
- 抓取新活动：只在这台 Mac 上抓。抓完后说一声，把这次新抓到的、还没结束的活动补进云上审核台。不要用整份本地数据库覆盖云上，避免冲掉云上已经勾好的商户和文案。审核和推送改在云上的审核台里做。
- 每天定时发布：在商户气泡页保存。定时存在那一台审核台自己的数据库里。要让电脑合盖后仍到点发布，必须在云上的审核台里打开定时，而不是只在家里电脑上打开。

## 先不要做的

- 审核台用公网 IP 加端口 `8790` 打开，先登录。不要把它挂进官网的 `80` / `443`，避免和现有网页抢地址。
- 不要停现有的 Zup 后台和官网。
- 抓取仍然留在自己电脑上。每天定时发气泡，等审核台在云上稳定开着之后再加。
