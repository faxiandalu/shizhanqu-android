# 怎么编译出 APK（照着做就行）

## 先说结论

这台电脑**现在编不了**：没有 Java（JDK）、没有 Android SDK，而且这台机器连 GitHub / Google 的网都被封了，
装不了依赖。所以 APK 得让**云端的机器**来编 —— 我们把源码传到 GitHub，GitHub 免费帮我们编好，再把 APK 下载回来。
整个过程你只需要：有一个 GitHub 账号、一个能上 GitHub 的电脑（或手机热点给电脑联网）。

源码我这边已经全部准备好了（23 个文件，并且已经做成本地 git 仓库），你不用再动代码。

---

## 路线 A：GitHub 云端编译（推荐，什么都不用装）

### 第 1 步：申请 GitHub 账号
打开 https://github.com 注册（用邮箱就行，免费账户每月有 2000 分钟云端编译额度，够用）。
如果你这台电脑浏览器打不开 GitHub，可以用**手机**注册，或者开着手机热点让电脑联网，之后步骤都在电脑上做。

### 第 2 步：生成一个 Token（相当于专用密码）
登录 GitHub 后打开这个链接：

> https://github.com/settings/tokens/new

- 勾选 **repo**（它下面所有子项会自动勾上）
- 拉到最下面点 **Generate token**
- 复制那串以 `ghp_` 开头的字符（**只显示这一次**，先粘到记事本里）

### 第 3 步：上传源码（两种方式，挑一个）

**方式 ① 双击脚本（最简单）**

在本文件夹里双击 **`上传GitHub.py`**，按提示输入：
- GitHub 用户名（不是邮箱）
- 刚生成那串 Token（粘贴后不显示，直接回车）
- 仓库名：直接回车用默认的 `shizhanqu-android`
- 是否私有：直接回车（私有，别人看不到你的数据相关的代码）

脚本会自动建仓库 → 上传 → 云端开始编译 → 自动打开进度页面。
首次运行若提示 “连接失败”，说明这台机器上不了网，换台能上网的电脑（把整个文件夹拷过去）或用方式 ②。

**方式 ② 手动上传（不想用脚本时）**

1. 在 https://github.com/new 建一个空仓库，名字 `shizhanqu-android`，**不要**勾 “Add a README file”
2. 进到空仓库页面，点 **uploading an existing file**（或把文件拖进页面的虚线框）
3. 把本文件夹里这些内容全拖进去（注意 `.github` 文件夹一定要拖，那是触发编译的关键）：
   ```
   .github/workflows/build-apk.yml
   app/（整个文件夹）
   build.gradle  settings.gradle  gradle.properties  .gitignore
   gradle/wrapper/gradle-wrapper.properties
   ```
4. 拉到下面点 **Commit changes**

> 拖不上去时，可以改用 git 命令行：在本文件夹打开终端
> `git remote add origin https://github.com/你的用户名/shizhanqu-android.git`
> `git branch -M main`
> `git push -u origin main`

### 第 4 步：等编译完成
上传后页面顶部会出现黄色/绿色的圆点，点顶部 **Actions** 标签，能看到 “打包安卓APK” 正在跑，约 3~5 分钟。

### 第 5 步：下载 APK
那一条运行记录变**绿色 ✓** 后点进去，滚动到页面最底部 **Artifacts** 区，
下载 **`入库实战区APK`**（是个 zip），解压出来就是 `app-debug.apk`。

### 第 6 步：装到手机
把 apk 传到手机（微信文件传输助手 / QQ / 数据线都行），点开安装，
系统会提示 “未知来源应用”，**允许**即可（安卓 8 以上会让你给那个来源开一次权限）。

---

## 路线 B：自己装 Android Studio（适合以后经常改）

要求：电脑能连 dl.google.com（公司/家庭宽带一般可以），硬盘有 10GB 空闲。

1. 装 https://developer.android.com/studio
2. 打开这个文件夹（File → Open，选 `实战区管理系统_安卓` 这一层）
3. 等它自动同步 Gradle（第一次要联网下载，慢）
4. 菜单 **Build → Build Bundle(s) / APK(s) → Build APK(s)**
5. 产物在 `app\build\outputs\apk\debug\app-debug.apk`

---

## 拿到 APK 之后：把数据装进手机

1. 电脑版 → 顶栏 **「数据同步」→「导出手机版数据库」** → 得到 `导出\手机版_shizhanqu_日期.db`（约 45MB）
   （导出前先把电脑版关掉，避免文件被占用）
2. 把这个 `.db` 传到手机（落在「下载」目录）
3. 手机打开 App → **「数据」→「选择数据库文件」** → 选中它 → 加载完就能查了

以后数据更新：
- 电脑上重新导出 db → 传手机 → App 里 **「数据」→「重新读取」**（不用重编 APK）
- 手机上写的记录/复盘要回电脑：手机 App **「导出」→「全部数据」** 存 CSV → 传回电脑 →
  电脑版 **「导入数据」→ 选 CSV → 方式选「按新ID更新」**

顺序提醒：**先回传 CSV，再覆盖更新 db**，否则手机上没回传的记录会被冲掉。

---

## 常见问题

| 现象 | 原因 / 办法 |
|---|---|
| 脚本提示 “连接失败” | 这台机器上不了 GitHub。换能上网的电脑，或用手机热点，或改走路线 B |
| 上传后 Actions 里没有任务 | `.github/workflows` 没传上去。手动方式务必把这个隐藏文件夹拖进去 |
| Actions 跑红了 | 点进去看红色步骤的日志，把报错截图给我，我来改。多数是 SDK 组件下载波动，点右上角 **Re-run** 重试一次通常就好 |
| 提示 Branch not main | 运行 `git branch -M main` 再 push（脚本里已经自动做了） |
| APK 装不上 | 手机开了纯净模式/未知来源拦截，去设置里允许该来源一次 |
| App 打开白屏 | 先确认已经选过 db 文件；仍不行的话把手机 USB 调试打开，我可以远程看日志 |
